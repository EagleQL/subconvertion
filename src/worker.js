import jsYaml from 'js-yaml';

const DEFAULT_UA = 'clash.meta';
const SUB_FETCH_TIMEOUT_MS = 20000;
const CLASH_UA_PATTERN = /clash|mihomo|meta|stash/i;
// Region detection for proxy-group membership; codes are matched only when not surrounded by letters
const REGION_PATTERNS = [
  /香港|港|(?<![a-z])hk(?![a-z])|hong ?kong|🇭🇰/i,
  /台湾|台|(?<![a-z])tw(?![a-z])|taiwan|🇹🇼/i,
  /日本|东京|大阪|(?<![a-z])jp(?![a-z])|japan|🇯🇵/i,
  /新加坡|狮城|(?<![a-z])sg(?![a-z])|singapore|🇸🇬/i,
  /美国|美|洛杉矶|硅谷|西雅图|(?<![a-z])us(?![a-z])|united states|america|🇺🇸/i,
  /韩国|韩|首尔|(?<![a-z])kr(?![a-z])|korea|🇰🇷/i,
  /英国|伦敦|(?<![a-z])(uk|gb)(?![a-z])|united kingdom|london|🇬🇧/i,
  /德国|(?<![a-z])de(?![a-z])|germany|🇩🇪/i,
];

const src_default = {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Any unexpected failure: serve the last good result for this query if there is one
      console.error(`[subconvertion] unhandled error: ${error?.stack || error}`);
      const url = new URL(request.url);
      const cached = url.searchParams.get("url") ? await getCache(env.SUB_BUCKET, await buildCacheKey(url)).catch(() => null) : null;
      if (cached)
        return cached;
      throw error;
    }
  }
};
async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.origin;
    const frontendUrl = 'https://raw.githubusercontent.com/bulianglin/psub/main/frontend.html';
    const SUB_BUCKET = env.SUB_BUCKET;
    // BACKEND 支持逗号分隔的多个后端, 按顺序尝试
    let backends = env.BACKEND.split(",")
      .map((b) => b.trim().replace(/(https?:\/\/[^/]+).*$/, "$1"))
      .filter((b) => b.length > 0);
    const subDir = "subscription";
    const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (pathSegments.length === 0) {
      const response = await fetch(frontendUrl);
      if (response.status !== 200) {
        return new Response('Failed to fetch frontend', { status: response.status });
      }
      const originalHtml = await response.text();
      const modifiedHtml = originalHtml.replace(/https:\/\/bulianglin2023\.dev/, host);
      return new Response(modifiedHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    } else if (pathSegments[0] === subDir) {
			// subConverter 端点回调本服务, 通过 KV 获取脱敏数据
      const key = pathSegments[pathSegments.length - 1];
      const object = await SUB_BUCKET.get(key);
      const object_headers = await SUB_BUCKET.get(key + "_headers");
      if (object === null)
        return new Response("Not Found", { status: 404 });
      if ("R2Bucket" === SUB_BUCKET.constructor.name) {
        const headers = object_headers ? new Headers(await object_headers.json()) : new Headers({ "Content-Type": "text/plain;charset=UTF-8" });
				// 此处返回的是经过base64编码的节点数据,
				// 格式:
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node1
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node2
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node3
        return new Response(object.body, { headers });
      } else {
        const headers = object_headers ? new Headers(JSON.parse(object_headers)) : new Headers({ "Content-Type": "text/plain;charset=UTF-8" });
        return new Response(object, { headers });
      }
    }

    const urlParam = url.searchParams.get("url");
    if (!urlParam)
      return new Response("Missing URL parameter", { status: 400 });
    const backendParam = url.searchParams.get("bd");
    if (backendParam && /^(https?:\/\/[^/]+)[.].+$/g.test(backendParam))
      // 指定的后端优先, 失败后仍回落到默认列表
      backends = [backendParam.replace(/(https?:\/\/[^/]+).*$/, "$1"), ...backends];
    const replacements = {};
    const replacedURIs = [];
    const keys = [];
    // Original (non-desensitized) YAML configs, used to restore nodes the backend drops
    const originalConfigs = [];
    let firstSubHeaders;
    // Last fully successful result per request is kept in R2 and served when fetching or converting fails
    const cacheKey = await buildCacheKey(url);
    // failedSubs: neither fresh content nor a per-subscription cache was available
    // subCacheHits: served from the per-subscription cache; degradedSubs: fresh but suspiciously shrunk
    let failedSubs = 0, subCacheHits = 0, degradedSubs = 0;
    const respond = (body, init) => {
      const headers = new Headers(init.headers);
      if (subCacheHits)
        headers.set('X-Subconvertion-Sub-Cache', String(subCacheHits));
      if (degradedSubs)
        headers.set('X-Subconvertion-Degraded', String(degradedSubs));
      // Only a complete, healthy result may replace the last good result
      if (failedSubs === 0 && degradedSubs === 0)
        ctx.waitUntil(putCache(SUB_BUCKET, cacheKey, body, headers).catch((e) => console.warn(`[subconvertion] cache write failed: ${e}`)));
      return new Response(body, { ...init, headers });
    };

    if (urlParam.startsWith("proxies:")) {
      const { format, data } = parseData(urlParam.replace(/\|/g, "\r\n"));
      if ("yaml" === format) {
        originalConfigs.push(cloneWithSuffix(data));
        const key = generateRandomStr(11);
        const replacedYAMLData = replaceYAML(data, replacements);
        if (replacedYAMLData) {
          await SUB_BUCKET.put(key, replacedYAMLData);
          keys.push(key);
          replacedURIs.push(`${host}/${subDir}/${key}`);
        }
      }
    } else {
			// 将订阅链接中的原始节点数据脱敏后暂存到 KV 中
      const urlParts = urlParam.split("|").filter((part) => part.trim() !== "");
      if (urlParts.length === 0)
        return new Response("There are no valid links", { status: 400 });
      const fetchHeaders = new Headers(request.headers);
      // Keep the client's UA (e.g. clash.meta from OpenClash) so the provider returns full mihomo configs
      if (!CLASH_UA_PATTERN.test(request.headers.get('User-Agent') || ''))
        fetchHeaders.set('User-Agent', DEFAULT_UA);
      // 并行抓取所有订阅; 单个订阅失败或内容异常时回落到该订阅上次成功的内容
      const loaded = await Promise.all(urlParts.map((url2) => isHttpUrl(url2)
        ? loadSubscription(url2, { method: request.method, headers: fetchHeaders }, SUB_BUCKET, ctx)
        : null));

      for (const [index, url2] of urlParts.entries()) {
        const key = generateRandomStr(11);
				// e.g.  https://api.xyz.com/?suffix=abc, we need to get 'abc' as the suffix
				let suffix = url.searchParams.get('suffix') || '';
        let parsedObj;
        if (isHttpUrl(url2)) {
					suffix = new URL(url2).searchParams?.get('suffix') || suffix;
          const sub = loaded[index];
          if (sub.source === 'none') {
            failedSubs++;
            continue;
          }
          if (sub.source === 'cache')
            subCacheHits++;
          if (sub.suspicious)
            degradedSubs++;
          parsedObj = sub.parsedObj;
          firstSubHeaders ??= sub.headers;
          await SUB_BUCKET.put(key + "_headers", JSON.stringify(Object.fromEntries(sub.headers)));
          keys.push(key);
        } else {
          parsedObj = parseData(url2);
        }
        if (/^(ssr?|vmess1?|trojan|vless|hysteria):\/\//.test(url2)) {
          const newLink = replaceInUri(url2, replacements, false);
          if (newLink)
            replacedURIs.push(newLink);
          continue;
        } else if (!isHttpUrl(url2) && linkToProxy(url2)) {
          // Single link of a protocol the backend cannot handle: keep it for restoration
          originalConfigs.push({ proxies: [linkToProxy(url2)] });
          continue;
        } else if ("base64" === parsedObj.format) {
          const links = parsedObj.data.split(/\r?\n/).filter((link) => link.trim() !== "");
          const newLinks = [];
          const extraProxies = [];
          for (const link of links) {
            const newLink = replaceInUri(link, replacements, false, suffix);
            if (newLink)
              newLinks.push(newLink);
            else {
              // hysteria2 / tuic / anytls links are not understood by the backend; convert them for restoration
              const proxy = linkToProxy(link, suffix);
              if (proxy)
                extraProxies.push(proxy);
            }
          }
          if (extraProxies.length)
            originalConfigs.push({ proxies: extraProxies });
          const replacedBase64Data = btoa(newLinks.join("\r\n"));
          if (replacedBase64Data) {
						// 将脱敏后的数据暂存到 KV 中
            await SUB_BUCKET.put(key, replacedBase64Data);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        } else if ("yaml" === parsedObj.format) {
          if (parsedObj.data?.proxies)
            originalConfigs.push(cloneWithSuffix(parsedObj.data, suffix));
          const replacedYAMLData = replaceYAML(parsedObj.data, replacements, suffix);
          if (replacedYAMLData) {
            await SUB_BUCKET.put(key, replacedYAMLData);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        }
      }
    }

    // 无论成功与否都清理暂存数据, 避免脱敏数据残留在 R2
    const cleanup = async () => {
      for (const key of keys) {
        await SUB_BUCKET.delete(key);
        await SUB_BUCKET.delete(key + "_headers");
      }
    };
    // 原始节点直接拼成配置(无模板); 仅对 clash 类目标可用
    const originalFallback = () => {
      if (!originalConfigs.length || !/^clash/i.test(url.searchParams.get("target") || ""))
        return null;
      const base = originalConfigs.find((c) => c["proxy-groups"]) || originalConfigs[0];
      const config = structuredClone(base);
      fillMissingProxies(config, originalConfigs.filter((c) => c !== base));
      const headers = new Headers({ "Content-Type": "text/yaml;charset=UTF-8", "X-Subconvertion-Fallback": "original" });
      const userInfo = firstSubHeaders?.get("subscription-userinfo");
      if (userInfo)
        headers.set("subscription-userinfo", userInfo);
      return new Response(jsYaml.dump(config), { status: 200, headers });
    };
    // 没有可交给后端转换的节点(全部订阅失败, 或只剩后端不支持的协议)
    if (replacedURIs.length === 0) {
      await cleanup();
      // 有订阅失败时优先用缓存; 否则说明拿到的都是新数据, 直接返回原始节点
      const cached = failedSubs > 0 || !originalConfigs.length ? await getCache(SUB_BUCKET, cacheKey) : null;
      const response = cached || originalFallback() || await getCache(SUB_BUCKET, cacheKey);
      return response || new Response("All subscriptions failed and no cache is available", { status: 502 });
    }

		// 请求 subConverter 模版转换端点API，获取转换后的数据
    const newUrl = replacedURIs.join("|");
    url.searchParams.set("url", newUrl);
    // 证书校验跟随机场原始配置(含分享链接里的 allowInsecure), 不让 scv 参数统一改写
    url.searchParams.delete("scv");
    let rpResponse;
    try {
      rpResponse = await fetchFromBackends(backends, url.pathname + url.search, request);
    } finally {
      await cleanup();
    }
    if (rpResponse.status === 200) {

			// receive the response from the subConverter endpoint, and recover the original data
      const plaintextData = await rpResponse.text();
      try {
        const decodedData = urlSafeBase64Decode(plaintextData);
				// 此处拿到的是经过base64编码的节点数据,
				// 格式:
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node1\r\n
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node2\r\n
				// trojan://x.com:47119?allowInsecure=1&peer=x.com&sni=x.com#node3\r\n
        const links = decodedData.split(/\r?\n/).filter((link) => link.trim() !== "");
        const newLinks = [];
        for (const link of links) {
					// 替换脱敏数据为原始数据
          const newLink = replaceInUri(link, replacements, true);
          if (newLink)
            newLinks.push(newLink);
        }
        const replacedBase64Data = btoa(newLinks.join("\r\n"));
        if (newLinks.length)
          return respond(replacedBase64Data, { status: rpResponse.status, statusText: rpResponse.statusText, headers: rpResponse.headers });
        return new Response(replacedBase64Data, rpResponse);
      } catch (base64Error) {
        let result = plaintextData.replace(
          new RegExp(Object.keys(replacements).join("|"), "g"),
          (match) => replacements[match] || match
        );
				// 此处拿到的可能是yaml数据,如果是yaml数据,则把placeholderNodes添加到yaml数据中的proxies字段中
				try {
					const config = jsYaml.load(result);
					// 后端不支持的协议(如 anytls / vless reality)会被丢弃, 用原始节点补齐
					const { restored: filledCount, backfilled } = config && typeof config === 'object'
						? fillMissingProxies(config, originalConfigs) : { restored: 0, backfilled: 0 };
					if (filledCount || backfilled)
						console.warn(`[subconvertion] restored ${filledCount} node(s), backfilled fields on ${backfilled} node(s)`);
					if (config.proxies?.length) {
						const callbackNode = { ...config.proxies[0], name: '🚥‼️ 临替节点' };
						config.proxies.push(callbackNode);
						// 检查所有的proxy-groups, 如果哪个proxy-group下的proxies字段为空或者只包含DIRECT,则添加一个假的节点
						if (config["proxy-groups"]) {
							config["proxy-groups"].forEach((group) => {
								if(!group.proxies) {
									group.proxies = [];
								}
								if (!group.name?.includes('全球直连') && group.proxies.length === 1 && group.proxies[0] === "DIRECT") {
									// remove it first
									group.proxies = [];
								}
								if (group.proxies.length === 0) {
									group.proxies.push(callbackNode.name);
								}
							});
						}
					}
					const resultNew = jsYaml.dump(config);
					const headers = new Headers(rpResponse.headers);
					if (filledCount)
						headers.set('X-Subconvertion-Restored', String(filledCount));
					if (backfilled)
						headers.set('X-Subconvertion-Backfilled', String(backfilled));
					if (config.proxies?.length)
						return respond(resultNew, { status: rpResponse.status, statusText: rpResponse.statusText, headers });
					return new Response(resultNew, { status: rpResponse.status, statusText: rpResponse.statusText, headers });
				} catch (error) {
					// 如果不是yaml数据,则直接返回
					return new Response(result, rpResponse);
				}
      }
    } else {
			const respBody = await rpResponse.clone().text();
			// console.error(`[subconvertion] Subscription failed: ${url}, status: ${rpResponse.status}, statusText: ${rpResponse.statusText}, body: ${respBody}`);
			// 后端失败时优先返回上次成功的缓存(保留模板策略组), 其次返回原始配置
			const cached = await getCache(SUB_BUCKET, cacheKey);
			if (cached) {
				console.warn(`[subconvertion] backend failed (${rpResponse.status}: ${respBody.slice(0, 100)}), serving cached result`);
				return cached;
			}
			// 后端整体失败(如所有节点都不被支持)时, 对 clash 类目标直接返回原始配置, 保证订阅可用
			const fallback = originalFallback();
			if (fallback) {
				console.warn(`[subconvertion] backend failed (${rpResponse.status}: ${respBody.slice(0, 100)}), falling back to original config`);
				return fallback;
			}
		}
    return rpResponse;
}
// 依次请求各后端, 返回第一个 200 的响应; 全部失败时返回最后一个响应(或 502)
async function fetchFromBackends(backends, pathAndSearch, request) {
  const BACKEND_TIMEOUT_MS = 15000;
  const BACKEND_BODY_TIMEOUT_MS = 20000;
  let lastResponse;
  for (const backend of [...new Set(backends)]) {
    // Separate budgets for headers and body, so a slow-but-alive large body is not cut off at the header timeout
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error(`headers timeout after ${BACKEND_TIMEOUT_MS}ms`)), BACKEND_TIMEOUT_MS);
    try {
      const resp = await fetch(new Request(backend + pathAndSearch, request), { signal: controller.signal });
      clearTimeout(timer);
      if (resp.status === 200) {
        // Buffer the body here so a broken or stalled stream fails over to the next backend instead of throwing later
        timer = setTimeout(() => controller.abort(new Error(`body timeout after ${BACKEND_BODY_TIMEOUT_MS}ms`)), BACKEND_BODY_TIMEOUT_MS);
        const body = await resp.arrayBuffer();
        clearTimeout(timer);
        return new Response(body, resp);
      }
      console.warn(`[subconvertion] backend ${backend} returned ${resp.status}, trying next`);
      lastResponse = resp;
    } catch (error) {
      clearTimeout(timer);
      console.warn(`[subconvertion] backend ${backend} failed: ${error}, trying next`);
    }
  }
  return lastResponse || new Response("All backends failed", { status: 502 });
}
function replaceInUri(link, replacements, isRecovery, suffix = '') {
  // switch (true) {
  //   case link.startsWith("ss://"):
  //     return replaceSS(link, replacements, isRecovery);
  //   case link.startsWith("ssr://"):
  //     return replaceSSR(link, replacements, isRecovery);
  //   case link.startsWith("vmess://"):
  //   case link.startsWith("vmess1://"):
  //     return replaceVmess(link, replacements, isRecovery);
  //   case link.startsWith("trojan://"):
  //   case link.startsWith("vless://"):
  //     return replaceTrojan(link, replacements, isRecovery);
  //   case link.startsWith("hysteria://"):
  //     return replaceHysteria(link, replacements);
  //   default:
  //     return;
  // }
	let result;
	switch (true) {
		case link.startsWith("ss://"):
			result = replaceSS(link, replacements, isRecovery);
			break;
		case link.startsWith("ssr://"):
			result = replaceSSR(link, replacements, isRecovery);
			break;
		case link.startsWith("vmess://"):
		case link.startsWith("vmess1://"):
			result = replaceVmess(link, replacements, isRecovery);
			break;
		case link.startsWith("trojan://"):
		case link.startsWith("vless://"):
			result = replaceTrojan(link, replacements, isRecovery);
			break;
		case link.startsWith("hysteria://"):
			result = replaceHysteria(link, replacements, isRecovery);
			break;
		default:
			return;
	}
	// 如果有后缀且有结果，在链接的备注部分添加后缀
	if (result && suffix) {
		const [linkPart, remarkPart = ''] = result.split('#');
		const newRemark = remarkPart ? `${remarkPart}${suffix}` : suffix.startsWith('#') ? suffix.slice(1) : suffix;
		return `${linkPart}#${newRemark}`;
	}
	return result;
}
function replaceSSR(link, replacements, isRecovery) {
  link = link.slice("ssr://".length).replace("\r", "").split("#")[0];
  link = urlSafeBase64Decode(link);
  const regexMatch = link.match(/(\S+):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
  if (!regexMatch) {
    return;
  }
  const [, server, , , , , password] = regexMatch;
  let replacedString;
  if (isRecovery) {
    replacedString = "ssr://" + urlSafeBase64Encode(link.replace(password, urlSafeBase64Encode(replacements[urlSafeBase64Decode(password)])).replace(server, replacements[server]));
  } else {
    const randomPassword = generateRandomStr(12);
    const randomDomain = generateRandomStr(12) + ".com";
    replacements[randomDomain] = server;
    replacements[randomPassword] = urlSafeBase64Decode(password);
    replacedString = "ssr://" + urlSafeBase64Encode(link.replace(server, randomDomain).replace(password, urlSafeBase64Encode(randomPassword)));
  }
  return replacedString;
}
function replaceVmess(link, replacements, isRecovery) {
  const randomUUID = generateRandomUUID();
  const randomDomain = generateRandomStr(10) + ".com";
  const regexMatchRocketStyle = link.match(/vmess:\/\/([A-Za-z0-9-_]+)\?(.*)/);
  if (regexMatchRocketStyle) {
    const base64Data = regexMatchRocketStyle[1];
    const regexMatch = urlSafeBase64Decode(base64Data).match(/(.*?):(.*?)@(.*):(.*)/);
    if (!regexMatch)
      return;
    const [, cipher, uuid, server, port] = regexMatch;
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    const newStr = urlSafeBase64Encode(`${cipher}:${randomUUID}@${randomDomain}:${port}`);
    const result = link.replace(base64Data, newStr);
    return result;
  }
  const regexMatchKitsunebiStyle = link.match(/vmess1:\/\/(.*?)@(.*):(.*?)\?(.*)/);
  if (regexMatchKitsunebiStyle) {
    const [, uuid, server] = regexMatchKitsunebiStyle;
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    const regex = new RegExp(`${uuid}|${server}`, "g");
    const result = link.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
    return result;
  }
  let tempLink = link.replace(/vmess:\/\/|vmess1:\/\//g, "");
  try {
    tempLink = urlSafeBase64Decode(tempLink);
    const regexMatchQuanStyle = tempLink.match(/(.*?) = (.*)/);
    if (regexMatchQuanStyle) {
      const configs = regexMatchQuanStyle[2].split(",");
      if (configs.length < 6)
        return;
      const server2 = configs[1].trim();
      const uuid2 = configs[4].trim().replace(/^"|"$/g, "");
      replacements[randomDomain] = server2;
      replacements[randomUUID] = uuid2;
      const regex2 = new RegExp(`${uuid2}|${server2}`, "g");
      const result2 = tempLink.replace(regex2, (match) => cReplace(match, uuid2, randomUUID, server2, randomDomain));
      return "vmess://" + btoa(result2);
    }
    const jsonData = JSON.parse(tempLink);
    const server = jsonData.add;
    const uuid = jsonData.id;
    const regex = new RegExp(`${uuid}|${server}`, "g");
    let result;
    if (isRecovery) {
      result = tempLink.replace(regex, (match) => cReplace(match, uuid, replacements[uuid], server, replacements[server]));
    } else {
      replacements[randomDomain] = server;
      replacements[randomUUID] = uuid;
      result = tempLink.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
    }
    return "vmess://" + btoa(result);
  } catch (error) {
    return;
  }
}
function replaceSS(link, replacements, isRecovery) {
  const randomPassword = generateRandomStr(12);
  const randomDomain = randomPassword + ".com";
  let replacedString;
  let tempLink = link.slice("ss://".length).split("#")[0];
  if (tempLink.includes("@")) {
    const regexMatch1 = tempLink.match(/(\S+?)@(\S+):/);
    if (!regexMatch1) {
      return;
    }
    const [, base64Data, server] = regexMatch1;
    const regexMatch2 = urlSafeBase64Decode(base64Data).match(/(\S+?):(\S+)/);
    if (!regexMatch2) {
      return;
    }
    const [, encryption, password] = regexMatch2;
    if (isRecovery) {
			// recovery the original data
      const newPswdStr = urlSafeBase64Encode(encryption + ":" + replacements[password]);
      replacedString = link.replace(base64Data, newPswdStr).replace(server, replacements[server]);
    } else {
			// encrypt the data
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      const newStr = urlSafeBase64Encode(encryption + ":" + randomPassword);
      replacedString = link.replace(base64Data, newStr).replace(/@.*:/, `@${randomDomain}:`);
    }
  } else {
		// proxying the encrypted data to the subConverter endpoint
    try {
      const decodedValue = urlSafeBase64Decode(tempLink);
      const regexMatch = decodedValue.match(/(\S+?):(\S+)@(\S+):/);
      if (!regexMatch) {
        return;
      }
      const [, , password, server] = regexMatch;
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      replacedString = "ss://" + urlSafeBase64Encode(decodedValue.replace(/:.*@/, `:${randomPassword}@`).replace(/@.*:/, `@${randomDomain}:`));
      const hashPart = link.match(/#.*/);
      if (hashPart)
        replacedString += hashPart[0];
    } catch (error) {
      return;
    }
  }
  return replacedString;
}
function replaceTrojan(link, replacements, isRecovery) {
  const randomUUID = generateRandomUUID();
  const randomDomain = generateRandomStr(10) + ".com";
  const regexMatch = link.match(/(vless|trojan):\/\/(.*?)@(.*):/);
  if (!regexMatch) {
    return;
  }
  const [, , uuid, server] = regexMatch;
  replacements[randomDomain] = server;
  replacements[randomUUID] = uuid;
  const regex = new RegExp(`${uuid}|${server}`, "g");
  if (isRecovery) {
    return link.replace(regex, (match) => cReplace(match, uuid, replacements[uuid], server, replacements[server]));
  } else {
    return link.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
  }
}
function replaceHysteria(link, replacements, isRecovery) {
  const regexMatch = link.match(/hysteria:\/\/(.*):(.*?)\?/);
  if (!regexMatch) {
    return;
  }
  const server = regexMatch[1];
  const auth = link.match(/[?&]auth=([^&#]+)/)?.[1];
  if (isRecovery) {
    // server/auth 此时是脱敏后的值, 换回原始值 (peer 等参数里同名的域名一并还原)
    let result = link.split(server).join(replacements[server] ?? server);
    if (auth && replacements[auth])
      result = result.replace(`auth=${auth}`, `auth=${replacements[auth]}`);
    return result;
  }
  const randomDomain = generateRandomStr(12) + ".com";
  replacements[randomDomain] = server;
  let result = link.split(server).join(randomDomain);
  if (auth) {
    const randomAuth = generateRandomStr(12);
    replacements[randomAuth] = auth;
    result = result.replace(`auth=${auth}`, `auth=${randomAuth}`);
  }
  return result;
}
function replaceYAML(yamlObj, replacements, suffix = '') {
  if (!yamlObj.proxies) {
    return;
  }
  yamlObj.proxies.forEach((proxy) => {
    const randomPassword = generateRandomStr(12);
    const randomDomain = randomPassword + ".com";
    const originalServer = proxy.server;
    proxy.server = randomDomain;
    replacements[randomDomain] = originalServer;
    if (proxy.password) {
      const originalPassword = proxy.password;
      proxy.password = randomPassword;
      replacements[randomPassword] = originalPassword;
    }
    if (proxy.uuid) {
      const originalUUID = proxy.uuid;
      const randomUUID = generateRandomUUID();
      proxy.uuid = randomUUID;
      replacements[randomUUID] = originalUUID;
    }
		proxy.remarks = proxy.remarks ? `${proxy.remarks}${suffix}` : suffix;
		proxy.name = proxy.name ? `${proxy.name}${suffix}` : suffix;
  });
  return jsYaml.dump(yamlObj);
}
// Deep-copy a parsed config, applying the same name suffix replaceYAML uses
function cloneWithSuffix(yamlObj, suffix = '') {
  const copy = structuredClone(yamlObj);
  if (suffix && Array.isArray(copy?.proxies))
    copy.proxies.forEach((proxy) => { proxy.name = proxy.name ? `${proxy.name}${suffix}` : suffix; });
  return copy;
}
// Endpoint + credential; several CDN-fronted nodes may share it, so DETAIL_FIELDS disambiguate
function proxyKey(proxy) {
  return `${proxy.server}|${proxy.port}|${proxy.uuid || proxy.password || ''}`;
}
const DETAIL_FIELDS = [
  (p) => p.type,
  (p) => p.servername || p.sni,
  (p) => p.network,
  (p) => p['ws-opts']?.path,
  (p) => p['ws-opts']?.headers?.Host,
  (p) => p['grpc-opts']?.['grpc-service-name'],
];
// strict: every detail equal; lenient: a detail omitted on either side is accepted (backends drop defaults)
function detailsMatch(a, b, strict) {
  return DETAIL_FIELDS.every((field) => {
    const x = field(a), y = field(b);
    return x == null || y == null ? (!strict || x == y) : String(x) === String(y);
  });
}
// One-to-one match of original nodes to converted nodes (independent of renaming by the backend).
// Returns a Map original -> converted; unmatched originals were dropped by the backend.
function matchProxies(converted, originals) {
  const byKey = new Map();
  for (const proxy of converted) {
    const key = proxyKey(proxy);
    byKey.set(key, [...(byKey.get(key) || []), proxy]);
  }
  const used = new Set();
  const matches = new Map();
  for (const strict of [true, false]) {
    for (const original of originals) {
      if (matches.has(original))
        continue;
      const candidate = (byKey.get(proxyKey(original)) || []).find((p) => !used.has(p) && detailsMatch(original, p, strict));
      if (candidate) {
        used.add(candidate);
        matches.set(original, candidate);
      }
    }
  }
  return matches;
}
// Node fields that must follow the provider's original config rather than conversion options
const PROVIDER_FIELDS = ['skip-cert-verify'];
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Copy keys present in source but missing in target (recursively), e.g. ech-opts dropped by the backend.
// Existing values are never overwritten, so backend options such as scv/udp still apply.
function backfillMissingFields(target, source) {
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'name')
      continue;
    if (!(key in target)) {
      target[key] = structuredClone(value);
      count++;
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      count += backfillMissingFields(target[key], value);
    }
  }
  return count;
}
function regionOf(name) {
  return REGION_PATTERNS.find((pattern) => pattern.test(name || ''));
}
// Reconcile converted nodes with the originals: backfill fields the backend dropped on kept nodes,
// append nodes the backend dropped entirely and add them to matching proxy-groups.
// Returns { restored, backfilled } (backfilled = number of nodes that received fields).
function fillMissingProxies(config, originalConfigs) {
  const originals = originalConfigs.flatMap((c) => (Array.isArray(c?.proxies) ? c.proxies : []));
  if (!originals.length)
    return { restored: 0, backfilled: 0 };
  if (!Array.isArray(config.proxies))
    config.proxies = [];
  const matches = matchProxies(config.proxies, originals);
  let backfilled = 0;
  for (const [original, converted] of matches) {
    if (backfillMissingFields(converted, original))
      backfilled++;
    // Fields the provider decides: take them verbatim from the original node (absent stays absent)
    for (const key of PROVIDER_FIELDS) {
      if (key in original)
        converted[key] = structuredClone(original[key]);
      else
        delete converted[key];
    }
  }
  const existingNames = new Set(config.proxies.map((p) => p.name));
  const realNames = new Set(existingNames);
  const seen = new Set();
  const missing = [];
  for (const proxy of originals) {
    if (matches.has(proxy))
      continue;
    // Skip exact duplicates (e.g. the same node listed by two subscriptions)
    const { name: _, ...rest } = proxy;
    const signature = JSON.stringify(rest);
    if (seen.has(signature))
      continue;
    seen.add(signature);
    let name = proxy.name || 'node';
    for (let i = 2; existingNames.has(name); i++)
      name = `${proxy.name} ${i}`;
    existingNames.add(name);
    missing.push({ ...proxy, name });
  }
  if (missing.length) {
    config.proxies.push(...missing);
    addToProxyGroups(config, missing, realNames);
  }
  return { restored: missing.length, backfilled };
}
function addToProxyGroups(config, missing, realNames) {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  groups.forEach((group) => {
    // Provider/filter based groups pick up nodes on their own
    if (group.use || group['include-all'] || group['include-all-proxies'])
      return;
    const members = (group.proxies || []).filter((n) => realNames.has(n));
    const nameRegion = regionOf(group.name);
    let toAdd = [];
    if (realNames.size > 0 && members.length === realNames.size) {
      // Group contains every remaining node: a region-named group stays region-only, otherwise take all
      toAdd = nameRegion ? missing.filter((p) => nameRegion.test(p.name)) : missing;
    } else if (members.length > 0) {
      // Region group: all current members share one region
      const region = REGION_PATTERNS.find((pattern) => members.every((n) => pattern.test(n)));
      if (region)
        toAdd = missing.filter((p) => region.test(p.name));
    } else {
      // Empty group (backend dropped all its nodes): infer region from the group name
      if (nameRegion)
        toAdd = missing.filter((p) => nameRegion.test(p.name));
      else if (realNames.size === 0 && !group.name?.includes('全球直连')
        && (group.proxies || []).every((n) => n === 'DIRECT'))
        // Every node was dropped: refill groups that only held built-in placeholders
        toAdd = missing;
    }
    if (!toAdd.length)
      return;
    group.proxies = group.proxies || [];
    // Drop a lone DIRECT placeholder in non-direct groups, mirroring the existing callback-node logic
    if (!group.name?.includes('全球直连') && group.proxies.length === 1 && group.proxies[0] === 'DIRECT')
      group.proxies = [];
    for (const p of toAdd)
      if (!group.proxies.includes(p.name))
        group.proxies.push(p.name);
  });
}
function isHttpUrl(link) {
  return link.startsWith("https://") || link.startsWith("http://");
}
// Provider "nodes" that only carry notices (traffic left, expiry, website...) are not usable proxies.
// Plain "流量" is deliberately excluded: real node names often contain e.g. "流量倍率:1"
const INFO_NODE_PATTERN = /剩余|到期|过期|套餐|官网|网址|重置|续费|公告|客服|群组|expire|remaining/i;
function nodeNameOfLink(link) {
  const hash = link.indexOf('#');
  if (hash >= 0) {
    try { return decodeURIComponent(link.slice(hash + 1)); } catch { return link.slice(hash + 1); }
  }
  if (link.startsWith('vmess://')) {
    try { return JSON.parse(urlSafeBase64Decode(link.slice(8))).ps || ''; } catch { return ''; }
  }
  return '';
}
// Number of usable nodes in a parsed subscription (notice-only entries excluded)
function countRealNodes(parsedObj) {
  if (parsedObj.format === 'yaml')
    return Array.isArray(parsedObj.data?.proxies)
      ? parsedObj.data.proxies.filter((p) => p?.server && !INFO_NODE_PATTERN.test(p.name || '')).length
      : 0;
  if (parsedObj.format === 'base64')
    return parsedObj.data.split(/\r?\n/)
      .filter((l) => /^[a-z0-9]+:\/\//i.test(l.trim()) && !INFO_NODE_PATTERN.test(nodeNameOfLink(l.trim()))).length;
  return 0;
}
const SUB_CACHE_PREFIX = 'subcache/';
const SUB_CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const SUB_CACHE_REFRESH_MS = 7 * 24 * 3600 * 1000;
// Fetch one subscription; on failure, empty/notice-only content, fall back to its last good content.
// Returns { source: 'fresh' | 'cache' | 'none', parsedObj, headers, suspicious }
async function loadSubscription(subUrl, init, bucket, ctx) {
  const host = new URL(subUrl).host;
  const cacheKey = SUB_CACHE_PREFIX + await sha256Hex(subUrl);
  let fresh;
  try {
    // Bound the whole download (headers + body) so a hung provider cannot stall the request
    const response = await fetch(subUrl, { ...init, redirect: 'follow', signal: AbortSignal.timeout(SUB_FETCH_TIMEOUT_MS) });
    if (response.ok) {
      const text = await response.text();
      fresh = { text, headers: response.headers, parsedObj: parseData(text) };
    } else {
      console.warn(`[subconvertion] Fetch failed: ${host}, status: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[subconvertion] Fetch error: ${host}, ${error}`);
  }
  const cached = await readSubCache(bucket, cacheKey).catch(() => null);
  if (fresh) {
    const nodeCount = countRealNodes(fresh.parsedObj);
    if (nodeCount > 0) {
      // A sharp drop (e.g. plan expired, provider glitch) must not overwrite the last good copy,
      // unless that copy is old enough that the drop is likely permanent
      const suspicious = !!cached && cached.nodeCount >= 5 && nodeCount < cached.nodeCount * 0.3;
      if (suspicious)
        console.warn(`[subconvertion] ${host}: node count dropped ${cached.nodeCount} -> ${nodeCount}`);
      if (!suspicious || Date.now() - cached.cachedAt > SUB_CACHE_REFRESH_MS)
        ctx.waitUntil(writeSubCache(bucket, cacheKey, fresh.text, fresh.headers, nodeCount).catch((e) => console.warn(`[subconvertion] sub cache write failed: ${e}`)));
      return { source: 'fresh', parsedObj: fresh.parsedObj, headers: fresh.headers, suspicious };
    }
    console.warn(`[subconvertion] No usable nodes from ${host}`);
  }
  if (cached && Date.now() - cached.cachedAt <= SUB_CACHE_MAX_AGE_MS) {
    console.warn(`[subconvertion] ${host}: using cached subscription (age ${Math.round((Date.now() - cached.cachedAt) / 1000)}s)`);
    return { source: 'cache', parsedObj: parseData(cached.text), headers: cached.headers };
  }
  return { source: 'none' };
}
async function readSubCache(bucket, key) {
  if (typeof bucket?.head !== 'function')
    return null;
  const object = await bucket.get(key);
  if (!object)
    return null;
  return {
    text: await object.text(),
    headers: new Headers(JSON.parse(object.customMetadata?.headers || '{}')),
    nodeCount: Number(object.customMetadata?.nodeCount || 0),
    cachedAt: Number(object.customMetadata?.cachedAt || 0),
  };
}
async function writeSubCache(bucket, key, text, headers, nodeCount) {
  if (typeof bucket?.head !== 'function')
    return;
  const source = new Headers(headers);
  const kept = Object.fromEntries(CACHED_HEADERS.filter((h) => source.has(h)).map((h) => [h, source.get(h)]));
  await bucket.put(key, text, { customMetadata: { headers: JSON.stringify(kept), nodeCount: String(nodeCount), cachedAt: String(Date.now()) } });
}
// Convert share links of protocols the backend does not support into mihomo proxy objects
function linkToProxy(link, suffix = '') {
  let u;
  try {
    u = new URL(link.trim());
  } catch {
    return;
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (!['hysteria2', 'hy2', 'tuic', 'anytls'].includes(scheme) || !u.hostname)
    return;
  const q = u.searchParams;
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const server = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 443;
  const proxy = { name: `${decode(u.hash.slice(1)) || `${server}:${port}`}${suffix}`, server, port, udp: true };
  const sni = q.get('sni') || q.get('peer');
  if (sni)
    proxy.sni = sni;
  if (['1', 'true'].includes((q.get('insecure') || q.get('allowInsecure') || q.get('allow_insecure') || '').toLowerCase()))
    proxy['skip-cert-verify'] = true;
  if (q.get('alpn'))
    proxy.alpn = q.get('alpn').split(',');
  switch (scheme) {
    case 'hysteria2':
    case 'hy2':
      proxy.type = 'hysteria2';
      proxy.password = decode(u.password ? `${u.username}:${u.password}` : u.username);
      if (q.get('obfs')) {
        proxy.obfs = q.get('obfs');
        proxy['obfs-password'] = q.get('obfs-password') || '';
      }
      if (q.get('mport'))
        proxy.ports = q.get('mport');
      break;
    case 'tuic':
      proxy.type = 'tuic';
      proxy.uuid = decode(u.username);
      proxy.password = decode(u.password);
      proxy['congestion-controller'] = q.get('congestion_control') || 'bbr';
      proxy['udp-relay-mode'] = q.get('udp_relay_mode') || 'native';
      break;
    case 'anytls':
      proxy.type = 'anytls';
      proxy.password = decode(u.username);
      break;
  }
  return proxy;
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const CACHE_PREFIX = 'cache/';
const CACHED_HEADERS = ['content-type', 'content-disposition', 'subscription-userinfo', 'profile-update-interval', 'profile-web-page-url'];
// Cache key derived from the full query (subscription URLs, target, template...), hashed so it is unguessable
async function buildCacheKey(url) {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return CACHE_PREFIX + await sha256Hex(url.pathname + '?' + new URLSearchParams(params));
}
async function putCache(bucket, key, body, headers) {
  // Only R2 supports custom metadata; skip caching for KV bindings
  if (typeof bucket?.head !== 'function')
    return;
  const source = new Headers(headers);
  const kept = Object.fromEntries(CACHED_HEADERS.filter((h) => source.has(h)).map((h) => [h, source.get(h)]));
  await bucket.put(key, body, { customMetadata: { headers: JSON.stringify(kept), cachedAt: String(Date.now()) } });
}
async function getCache(bucket, key) {
  if (typeof bucket?.head !== 'function')
    return null;
  const object = await bucket.get(key);
  if (!object)
    return null;
  const headers = new Headers(JSON.parse(object.customMetadata?.headers || '{}'));
  const ageSeconds = Math.round((Date.now() - Number(object.customMetadata?.cachedAt || Date.now())) / 1000);
  headers.set('X-Subconvertion-Cache', `hit; age=${ageSeconds}`);
  return new Response(object.body, { status: 200, headers });
}
function urlSafeBase64Encode(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function urlSafeBase64Decode(input) {
  const padded = input + "=".repeat((4 - input.length % 4) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}
function generateRandomStr(len) {
  return Math.random().toString(36).substring(2, len);
}
function generateRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c == "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function parseData(data) {
  try {
    return { format: "base64", data: urlSafeBase64Decode(data) };
  } catch (base64Error) {
    try {
      return { format: "yaml", data: jsYaml.load(data) };
    } catch (yamlError) {
      return { format: "unknown", data };
    }
  }
}
function cReplace(match, ...replacementPairs) {
  for (let i = 0; i < replacementPairs.length; i += 2) {
    if (match === replacementPairs[i]) {
      return replacementPairs[i + 1];
    }
  }
  return match;
}
// 生成一些假的节点数据，避免客户端报错. 节点格式: {name: 香港-placeholder, server: wb.kaiqsz.com, port: 47119, type: trojan, password: 8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake, sni: mm1.redapricotcloud.com, 'skip-cert-verify': true, udp: true}
// 常见地区每个地区一个节点, 地区: 美国,日本,新加坡,香港,德国,荷兰,澳大利亚,加拿大,土耳其,越南,英国,台湾,韩国,印度,法国
function getPlaceholderNodes() {
	return [
		{name: '美国-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '日本-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '新加坡-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '香港-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '德国-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '荷兰-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '澳大利亚-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '加拿大-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '土耳其-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '越南-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '英国-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '台湾-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '韩国-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '印度-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '法国-placeholder', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},

		// 以下节点全部带有HQ后缀
		{name: '美国-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '日本-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '新加坡-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '香港-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '德国-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '荷兰-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '澳大利亚-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '加拿大-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '土耳其-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '越南-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '英国-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '台湾-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '韩国-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '印度-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '法国-placeholder-HQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},

		// 以下节点全部带有LQ后缀
		{name: '美国-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '日本-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '新加坡-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '香港-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '德国-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '荷兰-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '澳大利亚-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '加拿大-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '土耳其-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '越南-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '英国-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '台湾-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '韩国-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '印度-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
		{name: '法国-placeholder-LQ', server: 'wb.kaiqsz.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'mm1.redapricotcloud.com', 'skip-cert-verify': true, udp: true},
	]
}
export {
  src_default as default
};
//# sourceMappingURL=index.js.map
