import jsYaml from 'js-yaml';

const DEFAULT_UA = 'clash.meta';
const SUB_FETCH_TIMEOUT_MS = 20000;
// Single-subscription node lists answer within this budget (OpenClash reads subscription info with a 5s timeout)
const LIST_SOFT_DEADLINE_MS = 3500;
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
    let effective = request;
    try {
      // 短链接 /s/<token>[/<profile>]: 展开为完整的 /sub?... 请求
      const resolved = resolveShortLink(request, env);
      if (resolved instanceof Response)
        return resolved;
      effective = resolved || request;
      // The short link itself (not the expanded URL) is reused as the provider URL in provider mode
      return await handleRequest(effective, env, ctx, resolved ? request.url : null);
    } catch (error) {
      // Any unexpected failure: serve the last good result for this query if there is one
      console.error(`[subconvertion] unhandled error: ${error?.stack || error}`);
      const url = new URL(effective.url);
      const cached = url.searchParams.get("url") ? await getCache(env.SUB_BUCKET, await buildCacheKey(url)).catch(() => null) : null;
      if (cached)
        return cached;
      throw error;
    }
  }
};
const SHORT_LINK_PREFIX = 's';
// Expand /s/<token>[/<profile>] using the ACCESS_TOKEN and PROFILES secrets.
// PROFILES: {"<name>": {"subs": ["https://..."], "params": {"target": "clash", "config": "https://..."}}}
// Query parameters on the short link override the profile (including url and config).
// Returns null for other paths, a Response for rejected requests, or the expanded Request.
function resolveShortLink(request, env) {
  const url = new URL(request.url);
  const [prefix, token, profileName = 'default', ...rest] = url.pathname.split('/').filter(Boolean);
  if (prefix !== SHORT_LINK_PREFIX)
    return null;
  const tokens = (env.ACCESS_TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean);
  // Unknown token and unknown profile look the same, so neither can be probed
  if (!token || rest.length || !tokens.some((t) => timingSafeEqual(t, token)))
    return new Response('Not Found', { status: 404 });
  let profiles;
  try {
    profiles = JSON.parse(env.PROFILES || '{}');
  } catch {
    return new Response('Invalid PROFILES configuration', { status: 500 });
  }
  const profile = Object.hasOwn(profiles, profileName) ? profiles[profileName] : null;
  if (!profile)
    return new Response('Not Found', { status: 404 });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(profile.params || {}))
    params.set(key, String(value));
  const subs = Array.isArray(profile.subs) ? profile.subs.join('|') : profile.subs;
  if (subs)
    params.set('url', subs);
  // UA priority: profile ua < client's clash-like User-Agent header < ?ua= on the short link
  const headerUa = request.headers.get('User-Agent') || '';
  if (CLASH_UA_PATTERN.test(headerUa))
    params.set('ua', headerUa);
  for (const [key, value] of url.searchParams)
    params.set(key, value);
  return new Request(`${url.origin}/sub?${params}`, request);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleRequest(request, env, ctx, linkUrl = null) {
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
    // 规则集转换透传给后端(依次重试); 配置里的 rule-providers 地址会被改写到这里
    if (pathSegments[0] === "getruleset")
      return relayRuleset(url, backends, SUB_BUCKET, ctx);
    if (pathSegments[0] === "providers" && pathSegments[1] === FIXED_PROVIDER)
      return fixedProviderResponse(env, url);
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
    let failedSubs = 0, subCacheHits = 0, degradedSubs = 0, uaFallbackSubs = 0;
    // Per-subscription traffic/expiry, used for the aggregated header and the info nodes
    const subInfos = [];
    let userinfoOverride = null;
    const respond = (body, init) => {
      const headers = new Headers(init.headers);
      if (userinfoOverride)
        headers.set('subscription-userinfo', userinfoOverride);
      if (subCacheHits)
        headers.set('X-Subconvertion-Sub-Cache', String(subCacheHits));
      if (uaFallbackSubs)
        headers.set('X-Subconvertion-UA-Fallback', String(uaFallbackSubs));
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
      let urlParts = urlParam.split("|").filter((part) => part.trim() !== "");
      if (urlParts.length === 0)
        return new Response("There are no valid links", { status: 400 });
      // sub=<id>: only one subscription (per-subscription proxy-provider); id = hash prefix of its URL
      const subFilter = url.searchParams.get('sub');
      if (subFilter) {
        const ids = await Promise.all(urlParts.map(subId));
        urlParts = urlParts.filter((_, i) => ids[i] === subFilter);
        if (!urlParts.length)
          return new Response("Unknown subscription", { status: 404 });
      }
      const listMode = /^(1|true)$/i.test(url.searchParams.get('list') || '');
      const fetchHeaders = new Headers(request.headers);
      // UA used to fetch providers: ?ua= > client's clash-like UA (e.g. clash.meta from OpenClash) > default
      const uaParam = url.searchParams.get('ua');
      if (uaParam)
        fetchHeaders.set('User-Agent', uaParam);
      else if (!CLASH_UA_PATTERN.test(request.headers.get('User-Agent') || ''))
        fetchHeaders.set('User-Agent', DEFAULT_UA);
      // 首选 UA 失败(非 2xx 或无可用节点)时依次尝试的备选 UA
      const primaryUa = fetchHeaders.get('User-Agent');
      const uaCandidates = [...new Set([primaryUa, ...uaFallbacks(env)])];
      // 并行抓取所有订阅; 单个订阅失败或内容异常时回落到该订阅上次成功的内容
      // 单订阅节点列表供 provider/面板拉取, 客户端超时短(OpenClash 取订阅信息仅 5 秒): 超过软时限就先回缓存, 后台继续刷新
      const softDeadline = listMode && subFilter ? LIST_SOFT_DEADLINE_MS : 0;
      // IP 地址的订阅在 Cloudflare Worker 中无法 fetch, 跳过抓取; provider 模式下由客户端直接拉取
      const loaded = await Promise.all(urlParts.map((url2) => (isHttpUrl(url2) && !isIpHttpUrl(url2))
        ? loadSubscription(url2, { method: request.method, headers: fetchHeaders }, SUB_BUCKET, ctx, uaCandidates, softDeadline)
        : null));

      // 单订阅节点列表且机场返回 mihomo YAML: 直接透传(不经后端), 快且不丢字段
      if (listMode && subFilter && urlParts.length === 1 && isHttpUrl(urlParts[0])
        && loaded[0]?.source && loaded[0].source !== 'none' && loaded[0].parsedObj.format === 'yaml') {
        const sub = loaded[0];
        if (sub.source === 'cache')
          subCacheHits++;
        if (sub.suspicious)
          degradedSubs++;
        if (sub.ua && sub.ua !== primaryUa)
          uaFallbackSubs++;
        const suffix = new URL(urlParts[0]).searchParams.get('suffix') || url.searchParams.get('suffix') || '';
        const info = await buildSubInfo(urlParts[0], sub, suffix);
        const proxies = cloneWithSuffix(sub.parsedObj.data, suffix).proxies
          .filter((p) => p && !INFO_NODE_PATTERN.test(p.name || ''));
        applyNodeDefaults(proxies, url.searchParams);
        proxies.push(infoNode(infoNodeName(info)));
        userinfoOverride = info.raw;
        return respond(jsYaml.dump({ proxies }), { status: 200, headers: { 'Content-Type': 'text/yaml;charset=UTF-8', 'X-Subconvertion-Native': '1' } });
      }

      for (const [index, url2] of urlParts.entries()) {
        const key = generateRandomStr(11);
				// e.g.  https://api.xyz.com/?suffix=abc, we need to get 'abc' as the suffix
				let suffix = url.searchParams.get('suffix') || '';
        let parsedObj;
        if (isHttpUrl(url2)) {
					suffix = new URL(url2).searchParams?.get('suffix') || suffix;
          if (isIpHttpUrl(url2)) {
            subInfos.push(await buildSubInfo(url2, { source: 'direct', ua: primaryUa }, suffix));
            continue;
          }
          const sub = loaded[index];
          const subInfo = await buildSubInfo(url2, sub, suffix);
          // Node names as the provider will deliver them, to detect clashes between subscriptions
          if (sub.source !== 'none')
            subInfo.nodeNames = subscriptionNodeNames(sub.parsedObj, suffix, url.searchParams);
          subInfos.push(subInfo);
          if (sub.source === 'none') {
            failedSubs++;
            continue;
          }
          if (sub.source === 'cache')
            subCacheHits++;
          if (sub.suspicious)
            degradedSubs++;
          if (sub.ua && sub.ua !== primaryUa)
            uaFallbackSubs++;
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

    // 多个订阅的流量信息汇总成一个 subscription-userinfo(用量求和, 到期取最早)
    userinfoOverride = aggregateUserinfo(subInfos.map((s) => s.info));
    // 无论成功与否都清理暂存数据, 避免脱敏数据残留在 R2
    const cleanup = async () => {
      for (const key of keys) {
        await SUB_BUCKET.delete(key);
        await SUB_BUCKET.delete(key + "_headers");
      }
    };
    // 原始节点直接拼成配置(无模板); 仅对 clash 类目标可用
    const originalFallback = async () => {
      if (!originalConfigs.length || !/^clash/i.test(url.searchParams.get("target") || ""))
        return null;
      const base = originalConfigs.find((c) => c["proxy-groups"]) || originalConfigs[0];
      const config = structuredClone(base);
      fillMissingProxies(config, originalConfigs.filter((c) => c !== base), url.searchParams);
      if (Array.isArray(config.proxies))
        applyNodeDefaults(config.proxies, url.searchParams);
      replaceInfoNodes(config, subInfos);
      const groupTemplate = await loadGroupTemplate(url.searchParams.get("config"));
      attachFixedProvider(config, groupTemplate, linkUrl || request.url, url.searchParams);
      const headers = new Headers({ "Content-Type": "text/yaml;charset=UTF-8", "X-Subconvertion-Fallback": "original" });
      const userInfo = userinfoOverride || firstSubHeaders?.get("subscription-userinfo");
      if (userInfo)
        headers.set("subscription-userinfo", userInfo);
      return new Response(jsYaml.dump(config), { status: 200, headers });
    };
    // 没有可交给后端转换的节点(全部订阅失败, 或只剩后端不支持的协议)
    if (replacedURIs.length === 0) {
      await cleanup();
      // 有订阅失败时优先用缓存; 否则说明拿到的都是新数据, 直接返回原始节点
      const cached = failedSubs > 0 || !originalConfigs.length ? await getCache(SUB_BUCKET, cacheKey) : null;
      const response = cached || await originalFallback() || await getCache(SUB_BUCKET, cacheKey);
      return response || new Response("All subscriptions failed and no cache is available", { status: 502 });
    }

		// 请求 subConverter 模版转换端点API，获取转换后的数据
    const newUrl = replacedURIs.join("|");
    url.searchParams.set("url", newUrl);
    // ua 只用于抓取机场订阅, 不传给后端
    url.searchParams.delete("ua");
    // provider=true: 输出以代理提供者组织的配置(不内联节点), 节点由 provider 从本服务的节点列表(list=true)拉取
    const providerMode = /^(1|true)$/i.test(url.searchParams.get("provider") || "");
    const providerInterval = Number(url.searchParams.get("provider_interval")) || DEFAULT_PROVIDER_INTERVAL;
    url.searchParams.delete("provider");
    url.searchParams.delete("provider_interval");
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
						? fillMissingProxies(config, originalConfigs, url.searchParams) : { restored: 0, backfilled: 0 };
					if (filledCount || backfilled)
						console.warn(`[subconvertion] restored ${filledCount} node(s), backfilled fields on ${backfilled} node(s)`);
					// 机场自带的「剩余流量/到期」提示节点换成每个订阅一个的汇总信息节点
					if (config && typeof config === 'object')
						replaceInfoNodes(config, subInfos);
					const groupTemplate = await loadGroupTemplate(url.searchParams.get("config"));
					const hasNodes = !!config.proxies?.length;
					// 临替节点只用于填补空策略组; 节点列表(list=true)和 provider 模式下不需要
					const fallbackAliases = [];
					if (hasNodes && config.proxies?.length && !providerMode) {
						const callbackName = addFallbackAlias(config, config.proxies[0]);
						if (callbackName)
							fallbackAliases.push(callbackName);
						if (!fallbackAliases.includes(PLACEHOLDER_GROUP))
							fallbackAliases.push(PLACEHOLDER_GROUP);
					}
					// 临替节点只用于填补空策略组; 节点列表(list=true)和 provider 模式下不需要
					if (hasNodes && config["proxy-groups"] && !providerMode) {
						// 检查所有的proxy-groups, 如果哪个proxy-group下的proxies字段为空或者只包含DIRECT,则添加临替节点
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
									for (const name of fallbackAliases)
										if (!group.proxies.includes(name))
											group.proxies.push(name);
								}
							});
						}
					}
					// 后端生成的规则集地址指向它自己的 managed prefix(可能是 127.0.0.1:25500), 改写为本服务的透传地址
					const rewrittenRulesets = rewriteRuleProviderUrls(config, host);
					if (rewrittenRulesets)
						console.warn(`[subconvertion] rewrote ${rewrittenRulesets} rule-provider url(s)`);
					if (hasNodes && providerMode && config["proxy-groups"])
						toProviderConfig(config, groupTemplate, linkUrl || request.url, providerInterval, subInfos, new Set(), fallbackAliases, url.searchParams);
					else if (config && typeof config === 'object' && config["proxy-groups"])
						attachFixedProvider(config, groupTemplate, linkUrl || request.url, url.searchParams);
					const resultNew = jsYaml.dump(config);
					const headers = new Headers(rpResponse.headers);
					if (filledCount)
						headers.set('X-Subconvertion-Restored', String(filledCount));
					if (backfilled)
						headers.set('X-Subconvertion-Backfilled', String(backfilled));
					if (hasNodes)
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
			const fallback = await originalFallback();
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
// Fields where an explicit value on the original node must win over url options (scv/udp),
// while nodes that omitted the field still inherit the option.
const PROVIDER_FIELDS = ['skip-cert-verify', 'udp'];
const EMOJI_RULES = [
  [/香港|港|(?<![a-z])hk(?![a-z])|hong ?kong/i, '🇭🇰'],
  [/台湾|台|台北|(?<![a-z])tw(?![a-z])|taiwan/i, '🇹🇼'],
  [/日本|东京|大阪|(?<![a-z])jp(?![a-z])|japan/i, '🇯🇵'],
  [/新加坡|狮城|(?<![a-z])sg(?![a-z])|singapore/i, '🇸🇬'],
  [/美国|洛杉矶|硅谷|西雅图|圣何塞|芝加哥|(?<![a-z])us(?![a-z])|united states|america/i, '🇺🇸'],
  [/韩国|韩|首尔|(?<![a-z])kr(?![a-z])|korea/i, '🇰🇷'],
  [/英国|伦敦|(?<![a-z])(uk|gb)(?![a-z])|united kingdom|england/i, '🇬🇧'],
  [/德国|法兰克福|(?<![a-z])de(?![a-z])|germany/i, '🇩🇪'],
  [/法国|巴黎|(?<![a-z])fr(?![a-z])|france/i, '🇫🇷'],
  [/荷兰|阿姆斯特丹|(?<![a-z])nl(?![a-z])|netherlands/i, '🇳🇱'],
  [/澳大利亚|澳洲|悉尼|(?<![a-z])au(?![a-z])|australia/i, '🇦🇺'],
  [/加拿大|多伦多|温哥华|(?<![a-z])ca(?![a-z])|canada/i, '🇨🇦'],
  [/土耳其|(?<![a-z])tr(?![a-z])|turkey|türkiye/i, '🇹🇷'],
  [/印度|孟买|(?<![a-z])in(?![a-z])|india/i, '🇮🇳'],
  [/越南|(?<![a-z])vn(?![a-z])|vietnam/i, '🇻🇳'],
  [/俄罗斯|莫斯科|(?<![a-z])ru(?![a-z])|russia/i, '🇷🇺'],
];
function parseBoolParam(params, key) {
  const value = params?.get(key);
  if (/^(1|true)$/i.test(value || ''))
    return true;
  if (/^(0|false)$/i.test(value || ''))
    return false;
  return undefined;
}
function withEmoji(name) {
  if (!name || /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|🏳️‍🌈|📊|🚥)/u.test(name))
    return name;
  const hit = EMOJI_RULES.find(([pattern]) => pattern.test(name));
  return `${hit ? hit[1] : '🏳️‍🌈'} ${name}`;
}
// Apply url options (udp, scv, emoji) to nodes that did not gone through the backend:
// udp/scv only fill in omitted fields (explicit provider values stay); emoji prefixes a flag.
function applyNodeDefaults(proxies, params) {
  if (!params || !proxies?.length)
    return;
  const udp = parseBoolParam(params, 'udp');
  const scv = parseBoolParam(params, 'scv');
  const emoji = parseBoolParam(params, 'emoji') ?? parseBoolParam(params, 'add_emoji');
  for (const proxy of proxies) {
    if (udp !== undefined && proxy.udp == null)
      proxy.udp = udp;
    if (scv !== undefined && proxy['skip-cert-verify'] == null)
      proxy['skip-cert-verify'] = scv;
    if (emoji && proxy.name)
      proxy.name = withEmoji(proxy.name);
  }
}
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
function fillMissingProxies(config, originalConfigs, params = null) {
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
    // Explicit provider values win over backend-applied scv/udp; omitted fields keep the backend's default
    for (const key of PROVIDER_FIELDS)
      if (original[key] != null)
        converted[key] = structuredClone(original[key]);
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
    applyNodeDefaults(missing, params);
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
// Point backend-generated ruleset URLs (…/getruleset?…) at this worker, which relays to the backends.
// Returns the number of rewritten providers.
function rewriteRuleProviderUrls(config, origin) {
  let count = 0;
  for (const provider of Object.values(config?.['rule-providers'] || {})) {
    if (typeof provider?.url !== 'string')
      continue;
    try {
      const source = new URL(provider.url);
      if (source.pathname !== '/getruleset' || source.origin === origin)
        continue;
      provider.url = `${origin}/getruleset${source.search}`;
      count++;
    } catch {
      // Not a URL; leave untouched
    }
  }
  return count;
}
// Convert a classical .list file to a Clash rule-provider payload; returns null if no rules are found
function listToClassicalPayload(text) {
  if (/^\s*payload\s*:/m.test(text))
    return text;
  const rules = text.split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter((l) => l && !/^(#|;|\/\/)/.test(l) && /^[A-Z0-9-]+,/i.test(l));
  return rules.length ? `payload:\n${rules.map((r) => `  - ${r}`).join('\n')}\n` : null;
}
// Serve /getruleset without edge caching so manual "Update" in the dashboard always pulls the latest rules.
// For classical Clash rulesets (type=6), fetch the source .list directly with a cache-busting query param
// (no third-party backend cache, much faster); fall back to the backends, then to the R2 last-good copy.
async function relayRuleset(url, backends, bucket, ctx) {
  const type = url.searchParams.get('type') || '';
  const encoded = url.searchParams.get('url') || '';
  const r2Key = `ruleset/${await sha256Hex(url.search)}`;
  const saveAndRespond = (body, source) => {
    if (typeof bucket?.head === 'function')
      ctx.waitUntil(bucket.put(r2Key, body).catch(() => {}));
    return new Response(body, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store', 'X-Subconvertion-Ruleset': source },
    });
  };
  let sourceUrl = '';
  try {
    sourceUrl = urlSafeBase64Decode(encoded).trim();
  } catch {}
  if (type === '6' && isHttpUrl(sourceUrl) && !sourceUrl.includes('|')) {
    try {
      const freshUrl = new URL(sourceUrl);
      freshUrl.searchParams.set('_t', String(Date.now()));
      const response = await fetch(freshUrl, { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
      if (response.ok) {
        const body = listToClassicalPayload(await response.text());
        if (body)
          return saveAndRespond(body, 'direct');
      }
    } catch (error) {
      console.warn(`[subconvertion] direct ruleset fetch failed (${sourceUrl}): ${error}`);
    }
  }
  // subconverter types 3/4/6 are Clash rule-provider formats, which must carry a payload list
  const needsPayload = ['3', '4', '6'].includes(type);
  for (const backend of [...new Set(backends)]) {
    try {
      const response = await fetch(`${backend}${url.pathname}${url.search}`, { signal: AbortSignal.timeout(15000) });
      if (response.status !== 200)
        continue;
      const body = await response.text();
      if (!body.trim() || (needsPayload && !/^\s*payload\s*:/m.test(body))) {
        console.warn(`[subconvertion] backend ${backend} returned an invalid ruleset, trying next`);
        continue;
      }
      return saveAndRespond(body, backend);
    } catch (error) {
      console.warn(`[subconvertion] backend ${backend} ruleset failed: ${error}`);
    }
  }
  const last = typeof bucket?.head === 'function' ? await bucket.get(r2Key).catch(() => null) : null;
  if (last)
    return new Response(last.body, { headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store', 'X-Subconvertion-Cache': 'ruleset-last-good' } });
  return new Response('All backends failed to provide the ruleset', { status: 502 });
}
const PROVIDER_NAME = 'subconvertion';
const FIXED_PROVIDER = 'phoenix-nolan';
const PLACEHOLDER_GROUP = '🚥‼️ 临替节点';
// 临替条目显示成「🚥‼️ 临替节点」加上被复制的那个节点的原名
function fallbackDisplayName(original) {
  const name = original || '';
  if (name.startsWith(PLACEHOLDER_GROUP))
    return name;
  return `${PLACEHOLDER_GROUP} ${name}`;
}
function fixedProviderUrl(href, params) {
  const source = new URL(href);
  const url = new URL(`/providers/${FIXED_PROVIDER}`, source.origin);
  const parts = source.pathname.split('/').filter(Boolean);
  if (parts[0] === SHORT_LINK_PREFIX && parts[1])
    url.searchParams.set('token', parts[1]);
  for (const key of ['emoji', 'add_emoji', 'udp', 'scv']) {
    const value = params?.get?.(key);
    if (value)
      url.searchParams.set(key, value);
  }
  return url.href;
}
function fixedProviderResponse(env, url) {
  const tokens = (env.ACCESS_TOKEN || '').split(',').map((token) => token.trim()).filter(Boolean);
  const token = url.searchParams.get('token') || '';
  if (tokens.length && !tokens.some((candidate) => timingSafeEqual(candidate, token)))
    return new Response('Not Found', { status: 404 });
  const proxies = expandFixedNodes(parseFixedNodes(env.FIXED_NODES)).map((entry) => entry.proxy);
  applyNodeDefaults(proxies, url.searchParams);
  return new Response(jsYaml.dump({ proxies }), {
    headers: { 'Content-Type': 'text/yaml;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}
// 按策略模板里的节点名正则把 phoenix-nolan 挂到对应分组，不写死国家。
// 临替分组使用这个提供者，所以固定节点会全部出现在临替里。
function attachFixedProvider(config, template, href, params) {
  if (!config || typeof config !== 'object' || !Array.isArray(config['proxy-groups']))
    return;
  config['proxy-providers'] = config['proxy-providers'] || {};
  config['proxy-providers'][FIXED_PROVIDER] = {
    type: 'http',
    url: fixedProviderUrl(href, params),
    path: `./proxy_providers/${FIXED_PROVIDER}.yaml`,
    interval: DEFAULT_PROVIDER_INTERVAL,
    'health-check': { enable: true, url: 'http://cp.cloudflare.com/generate_204', interval: 300, lazy: true },
  };
  for (const group of config['proxy-groups']) {
    if (group.name === PLACEHOLDER_GROUP || group.name?.includes('全球直连'))
      continue;
    const definition = template?.groups.get(group.name);
    if (!definition?.filters.length || definition.filters.some((filter) => filter.startsWith('!!')))
      continue;
    group.use = [...new Set([...(group.use || []), FIXED_PROVIDER])];
    if (!definition.filters.includes('.*') && !group.filter)
      group.filter = definition.filters.map((filter) => `(?:${filter})`).join('|');
  }
  let fallback = config['proxy-groups'].find((group) => group.name === PLACEHOLDER_GROUP);
  if (!fallback) {
    fallback = {
      name: PLACEHOLDER_GROUP, type: 'url-test', use: [],
      url: 'http://cp.cloudflare.com/generate_204', interval: 300, tolerance: 50, lazy: true,
    };
    config['proxy-groups'].push(fallback);
  }
  fallback.use = [...new Set([...(fallback.use || []), FIXED_PROVIDER])];
}
function addFallbackAlias(config, source) {
  if (!source?.name)
    return;
  const name = fallbackDisplayName(source.name);
  if (!config.proxies.some((proxy) => proxy.name === name))
    config.proxies.push({ ...structuredClone(source), name });
  return name;
}
const DEFAULT_PROVIDER_INTERVAL = 129600; // 36 hours
const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);
// Node list endpoint for a provider: same request (short link or long URL) with list=true,
// restricted to one subscription by sub=<id>
function buildProviderUrl(href, id) {
  const providerUrl = new URL(href);
  providerUrl.searchParams.delete('provider');
  providerUrl.searchParams.delete('provider_interval');
  providerUrl.searchParams.set('list', 'true');
  if (id)
    providerUrl.searchParams.set('sub', id);
  return providerUrl.href;
}
// Parse subconverter custom_proxy_group lines: name`type`members...[`test-url`interval,timeout,tolerance]
// Members starting with [] reference groups/policies; other members are node-name regexes.
// Also returns the template-wide include/exclude remark filters.
function parseGroupTemplate(ini) {
  const groups = new Map();
  let excludeRemarks = '', includeRemarks = '';
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('exclude_remarks='))
      excludeRemarks = line.slice('exclude_remarks='.length);
    else if (line.startsWith('include_remarks='))
      includeRemarks = line.slice('include_remarks='.length);
    if (!line.startsWith('custom_proxy_group='))
      continue;
    const [name, type, ...members] = line.slice('custom_proxy_group='.length).split('`');
    const refs = [], filters = [];
    for (const member of members) {
      if (member.startsWith('[]'))
        refs.push(member.slice(2));
      else if (member && !/^https?:\/\//.test(member) && !/^\d+(,\d*)*$/.test(member))
        filters.push(member);
    }
    groups.set(name, { type, refs, filters });
  }
  return { groups, excludeRemarks, includeRemarks };
}
async function loadGroupTemplate(configUrl) {
  if (!configUrl || !isHttpUrl(configUrl))
    return null;
  try {
    // Always read the latest template: a throwaway query param bypasses Cloudflare and GitHub CDN caches
    const freshUrl = new URL(configUrl);
    freshUrl.searchParams.set('_t', String(Date.now()));
    const response = await fetch(freshUrl, { signal: AbortSignal.timeout(10000) });
    return response.ok ? parseGroupTemplate(await response.text()) : null;
  } catch (error) {
    console.warn(`[subconvertion] template fetch failed: ${error}`);
    return null;
  }
}
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// FIXED_NODES is a JSON array of mihomo proxies. Each entry is one server and, unless tiers says
// otherwise, is emitted twice: the given name for normal groups, and the same name plus -HQ for HQ groups.
function parseFixedNodes(raw) {
  if (!raw || !String(raw).trim())
    return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((node) => node && typeof node === 'object' && node.name && node.server && node.type);
  } catch (error) {
    console.warn(`[subconvertion] FIXED_NODES is not valid JSON: ${error}`);
    return [];
  }
}
function expandFixedNodes(nodes) {
  const expanded = [];
  for (const node of nodes) {
    const tiers = Array.isArray(node.tiers) && node.tiers.length ? node.tiers : ['normal', 'hq'];
    const proxy = { ...node };
    delete proxy.tiers;
    if (tiers.includes('normal'))
      expanded.push({ proxy: structuredClone(proxy), fallback: true });
    if (tiers.includes('hq')) {
      const hqName = /(?:^|-)HQ$/i.test(proxy.name) ? proxy.name : `${proxy.name}-HQ`;
      if (hqName !== proxy.name)
        expanded.push({ proxy: { ...structuredClone(proxy), name: hqName }, fallback: false });
      else if (!tiers.includes('normal'))
        expanded.push({ proxy: structuredClone(proxy), fallback: false });
    }
  }
  return expanded;
}
// Rewrite a converted config so groups pull nodes from proxy-providers (one per subscription, so
// clients show traffic/expiry per subscription) instead of inline proxies.
// Node regexes come from the template so new nodes join the right groups on provider refresh;
// groups without a template definition fall back to an exact-name filter of their current nodes.
function toProviderConfig(config, template, href, interval, subInfos = [], fixedNames = new Set(), fallbackNames = [], params = null) {
  const providers = {};
  const seenNames = new Set();
  // mihomo keys nodes by name, so same-named nodes from different providers (e.g. two accounts of one
  // provider) collapse into one. Rename clashing providers' nodes client-side with an override suffix.
  const seenNodes = new Set();
  let clashIndex = 1;
  for (const sub of subInfos) {
    let name = sub.label;
    if (seenNames.has(name))
      name = `${name} #${sub.id}`;
    seenNames.add(name);
    if (sub.source === 'direct') {
      // IP subscription: the client fetches it directly; apply its suffix via provider override
      const directUrl = new URL(sub.url);
      directUrl.searchParams.delete('suffix');
      providers[name] = {
        url: directUrl.href,
        path: `./proxy_providers/sub-${sub.id}.yaml`,
        header: { 'User-Agent': [sub.ua || DEFAULT_UA] },
        ...(sub.suffix && { override: { 'additional-suffix': sub.suffix } }),
      };
      continue;
    }
    const nodes = sub.nodeNames || [];
    const clashes = nodes.some((n) => seenNodes.has(n));
    const marker = clashes ? ` ·${++clashIndex}` : '';
    for (const n of nodes)
      seenNodes.add(n + marker);
    providers[name] = {
      url: buildProviderUrl(href, sub.id),
      path: `./proxy_providers/sub-${sub.id}.yaml`,
      ...(marker && { override: { 'additional-suffix': marker } }),
    };
  }
  if (!Object.keys(providers).length)
    providers[PROVIDER_NAME] = { url: buildProviderUrl(href), path: `./proxy_providers/${PROVIDER_NAME}.yaml` };
  providers[FIXED_PROVIDER] = { url: fixedProviderUrl(href, params), path: `./proxy_providers/${FIXED_PROVIDER}.yaml` };
  const providerNames = Object.keys(providers);
  const fixedList = (config.proxies || []).filter((proxy) => fixedNames.has(proxy.name));
  const nodeNames = new Set((config.proxies || []).map((proxy) => proxy.name).filter((name) => !fixedNames.has(name)));
  // Nodes the providers will actually deliver (template include/exclude applied), to detect empty groups
  const compile = (pattern) => { try { return pattern ? new RegExp(pattern) : null; } catch { return undefined; } };
  const include = compile(template?.includeRemarks), exclude = compile(template?.excludeRemarks);
  const providerNodes = [...nodeNames].filter((n) => (!include || include.test(n)) && !(exclude && exclude.test(n)));
  const groupNames = new Set(config['proxy-groups'].map((g) => g.name));
  const isPolicy = (n) => groupNames.has(n) || BUILTIN_POLICIES.has(n);
  config['proxy-groups'] = config['proxy-groups'].map((group) => {
    const { proxies = [], ...rest } = group;
    const definition = template?.groups.get(group.name);
    const supported = definition && !definition.filters.some((f) => f.startsWith('!!'));
    let refs, filter, useProvider = false;
    if (supported) {
      refs = definition.refs.filter(isPolicy);
      if (definition.filters.length) {
        useProvider = true;
        if (!definition.filters.includes('.*'))
          filter = definition.filters.map((f) => `(?:${f})`).join('|');
      }
    } else {
      refs = proxies.filter(isPolicy);
      const nodes = proxies.filter((n) => nodeNames.has(n));
      if (nodes.length) {
        useProvider = true;
        filter = `^(?:${nodes.map(escapeRegex).join('|')})$`;
      }
    }
    const result = { ...rest };
    // Empty groups would fall back to mihomo's COMPATIBLE (= direct). Like the inline placeholder node,
    // give them a real proxy instead: a url-test group over all nodes. Only for groups empty right now,
    // so region groups that do have nodes keep their region semantics.
    const matcher = useProvider ? compile(filter) : null;
    const fixedMatched = useProvider
      ? fixedList.filter((proxy) => !filter || (matcher && matcher.test(proxy.name)))
      : [];
    const hasOtherOptions = refs.some((n) => n !== 'DIRECT');
    const emptyFiltered = useProvider && !hasOtherOptions && matcher !== undefined
      && !providerNodes.some((n) => !matcher || matcher.test(n))
      && fixedMatched.length === 0;
    const directOnly = !useProvider && (!refs.length || (refs.length === 1 && refs[0] === 'DIRECT')) && !group.name?.includes('全球直连');
    if (emptyFiltered || directOnly) {
      refs = [...refs.filter((n) => n !== 'DIRECT'), PLACEHOLDER_GROUP];
      for (const name of fallbackNames)
        if (!refs.includes(name))
          refs.push(name);
    } else {
      for (const proxy of fixedMatched)
        if (!refs.includes(proxy.name))
          refs.push(proxy.name);
    }
    if (refs.length || !useProvider)
      result.proxies = refs.length ? refs : ['DIRECT'];
    if (useProvider) {
      // A fresh array per group, so the YAML dump does not emit anchors/aliases
      result.use = [...providerNames];
      if (filter)
        result.filter = filter;
    }
    return result;
  });
  let fallbackGroup = config['proxy-groups'].find((group) => group.name === PLACEHOLDER_GROUP);
  if (!fallbackGroup) {
    fallbackGroup = {
      name: PLACEHOLDER_GROUP, type: 'url-test',
      url: 'http://cp.cloudflare.com/generate_204', interval: 300, tolerance: 50, lazy: true,
    };
    config['proxy-groups'].push(fallbackGroup);
  }
  fallbackGroup.use = [...new Set([...(fallbackGroup.use || []), ...providerNames])];
  const fallbackAliases = (config.proxies || []).filter((proxy) => fallbackNames.includes(proxy.name));
  delete config.proxies;
  const kept = [...fixedList];
  for (const alias of fallbackAliases)
    if (!kept.some((proxy) => proxy.name === alias.name))
      kept.push(alias);
  if (kept.length)
    config.proxies = kept;
  config['proxy-providers'] = Object.fromEntries(providerNames.map((name) => [name, {
    type: 'http',
    url: providers[name].url,
    path: providers[name].path,
    interval,
    ...(providers[name].header && { header: providers[name].header }),
    ...(providers[name].override && { override: providers[name].override }),
    // Template-wide node filters (the backend applied them to inline nodes before)
    ...(template?.includeRemarks && { filter: template.includeRemarks }),
    ...(template?.excludeRemarks && { 'exclude-filter': template.excludeRemarks }),
    'health-check': { enable: true, url: 'http://cp.cloudflare.com/generate_204', interval: 300, lazy: true },
  }]));
}
function isHttpUrl(link) {
  return link.startsWith("https://") || link.startsWith("http://");
}
// Cloudflare Workers cannot fetch IP-literal hosts; in provider mode the client fetches them directly
function isIpHttpUrl(link) {
  if (!isHttpUrl(link))
    return false;
  try {
    const host = new URL(link).hostname;
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[');
  } catch {
    return false;
  }
}
// Usable node names of a parsed subscription (suffix applied, notice nodes excluded)
function subscriptionNodeNames(parsedObj, suffix = '', params = null) {
  let names = [];
  if (parsedObj?.format === 'yaml')
    names = (parsedObj.data?.proxies || []).map((p) => p?.name).filter(Boolean);
  else if (parsedObj?.format === 'base64')
    names = parsedObj.data.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9]+:\/\//i.test(l)).map(nodeNameOfLink);
  const emoji = parseBoolParam(params, 'emoji') ?? parseBoolParam(params, 'add_emoji');
  return names.filter((n) => !INFO_NODE_PATTERN.test(n)).map((n) => (emoji ? withEmoji(n + suffix) : n + suffix));
}
// ---- Per-subscription traffic/expiry info ----
async function subId(subUrl) {
  return (await sha256Hex(subUrl)).slice(0, 8);
}
// host[:port]/path of a subscription with token-like path segments masked, prefixed with [suffix]
function subLabel(subUrl, suffix = '') {
  const u = new URL(subUrl);
  const path = u.pathname.split('/').filter(Boolean)
    .map((s) => (s.length >= 12 && /^[A-Za-z0-9_-]+$/.test(s) ? `${s.slice(0, 4)}…${s.slice(-4)}` : s))
    .join('/');
  const base = path ? `${u.host}/${path}` : u.host;
  const tag = (suffix || '').replace(/^[-_\s]+/, '');
  return tag ? `[${tag}] ${base}` : base;
}
function parseUserinfo(value) {
  if (!value)
    return null;
  const info = {};
  for (const part of value.split(';')) {
    const [key, val] = part.split('=').map((s) => s?.trim());
    if (key && val && /^\d+(\.\d+)?$/.test(val))
      info[key.toLowerCase()] = Number(val);
  }
  return Object.keys(info).length ? info : null;
}
// Sum traffic across subscriptions; expiry = the earliest one (0 = long-term / unknown)
function aggregateUserinfo(infos) {
  const valid = infos.filter(Boolean);
  if (!valid.length)
    return null;
  const sum = (key) => valid.reduce((total, info) => total + (info[key] || 0), 0);
  const expires = valid.map((info) => info.expire).filter((e) => e > 0);
  return `upload=${sum('upload')}; download=${sum('download')}; total=${sum('total')}; expire=${expires.length ? Math.min(...expires) : 0}`;
}
// suffix: the subscription's node-name suffix (e.g. -SsRro-HQ), appended to its info node so the
// info node joins the same template groups as that subscription's nodes (e.g. ⭐️ HQ 优质节点)
async function buildSubInfo(subUrl, sub, suffix = '') {
  const raw = sub.source === 'none' || sub.source === 'direct' ? null : sub.headers?.get('subscription-userinfo') || null;
  return { id: await subId(subUrl), url: subUrl, label: subLabel(subUrl, suffix), raw, info: parseUserinfo(raw), source: sub.source, stale: !!sub.stale, suffix, ua: sub.ua };
}
function formatBytes(bytes) {
  if (bytes >= 1024 ** 4)
    return `${(bytes / 1024 ** 4).toFixed(2)}T`;
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(2)}G`;
  return `${(bytes / 1024 ** 2).toFixed(0)}M`;
}
// Name of the info node shown for one subscription; contains "剩余" so template info groups match it
function infoNodeName(sub) {
  return infoNodeText(sub) + (sub.suffix || '');
}
function infoNodeText(sub) {
  const head = `📊 ${sub.label}`;
  if (sub.source === 'none')
    return `${head} | 获取失败 剩余 未知`;
  const { info } = sub;
  const cached = sub.source === 'cache' ? ' (缓存)' : '';
  if (!info || !info.total)
    return `${head} | 剩余 未知(未提供流量信息)${cached}`;
  const used = (info.upload || 0) + (info.download || 0);
  const expire = info.expire > 0 ? new Date(info.expire * 1000).toISOString().slice(0, 10) : '长期有效';
  return `${head} | 已用 ${formatBytes(used)} 剩余 ${formatBytes(Math.max(info.total - used, 0))} 共 ${formatBytes(info.total)} | 到期 ${expire}${cached}`;
}
// Unreachable placeholder so health checks never pick it and it carries no traffic
function infoNode(name) {
  return { name, type: 'socks5', server: '127.0.0.1', port: 1 };
}
// Replace the providers' own notice nodes (剩余流量 / 套餐到期 ...) with one info node per subscription.
// Info nodes go into the groups that held the notice nodes, or into info-like groups (e.g. 💰 剩余流量).
function replaceInfoNodes(config, subInfos) {
  if (!subInfos.length || !Array.isArray(config.proxies))
    return;
  const removed = new Set(config.proxies.filter((p) => INFO_NODE_PATTERN.test(p?.name || '')).map((p) => p.name));
  config.proxies = config.proxies.filter((p) => !removed.has(p?.name));
  const names = new Set(config.proxies.map((p) => p.name));
  const nodes = [];
  for (const sub of subInfos) {
    // IP subscriptions are fetched directly by the client in provider mode (with their own notice nodes)
    if (sub.source === 'direct')
      continue;
    let name = infoNodeName(sub);
    if (names.has(name))
      name = `${name} #${sub.id}`;
    names.add(name);
    nodes.push(infoNode(name));
  }
  config.proxies.push(...nodes);
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  let targets = groups.filter((g) => g.proxies?.some((n) => removed.has(n)));
  if (!targets.length)
    targets = groups.filter((g) => /剩余|流量|订阅信息|套餐/.test(g.name || ''));
  for (const group of groups) {
    if (group.proxies?.some((n) => removed.has(n)))
      group.proxies = group.proxies.filter((n) => !removed.has(n));
  }
  for (const group of targets) {
    group.proxies = group.proxies || [];
    for (const node of nodes)
      if (!group.proxies.includes(node.name))
        group.proxies.push(node.name);
  }
}
// Provider "nodes" that only carry notices (traffic left, expiry, website...) are not usable proxies.
// Plain "流量" is deliberately excluded: real node names often contain e.g. "流量倍率:1"
// Also covers placeholder nodes providers return for rejected clients (e.g. "访问受限", "请更新客户端")
const INFO_NODE_PATTERN = /剩余|到期|过期|套餐|官网|网址|重置|续费|公告|客服|群组|访问受限|请更新|请使用|不支持|expire|remaining/i;
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
// Fallback UAs tried in order when the preferred UA is rejected (env UA_FALLBACKS overrides, comma-separated)
const DEFAULT_UA_FALLBACKS = [
  'clash-verge/v2.4.2',
  'clash.meta',
  'mihomo/1.19.15',
  'ClashX Pro/1.118.1.1 (com.west2online.ClashXPro; build:1.118.1.1; macOS 15.4.1) Alamofire/5.8.0',
];
function uaFallbacks(env) {
  const configured = (env.UA_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_UA_FALLBACKS;
}
// Fetch one subscription trying each UA in order until one yields usable nodes; if none does
// (errors, empty or notice-only content), fall back to the subscription's last good content.
// softDeadlineMs > 0: if fresh content is not ready by then and a cached copy exists, return the
// cache right away and finish refreshing (and updating the cache) in the background.
// Returns { source: 'fresh' | 'cache' | 'none', parsedObj, headers, suspicious, ua, stale }
async function loadSubscription(subUrl, init, bucket, ctx, uaCandidates = [new Headers(init.headers).get('User-Agent')], softDeadlineMs = 0) {
  const host = new URL(subUrl).host;
  const cacheKey = SUB_CACHE_PREFIX + await sha256Hex(subUrl);
  const cachedPromise = readSubCache(bucket, cacheKey).catch(() => null);
  const freshPromise = fetchFreshSubscription(subUrl, init, uaCandidates, host);
  const isUsable = (cached) => cached && Date.now() - cached.cachedAt <= SUB_CACHE_MAX_AGE_MS;
  const cacheResult = (cached, stale) => ({ source: 'cache', parsedObj: parseData(cached.text), headers: cached.headers, stale });
  let fresh;
  if (softDeadlineMs > 0) {
    const cached = await cachedPromise;
    if (isUsable(cached)) {
      const timedOut = Symbol('timeout');
      const winner = await Promise.race([freshPromise, new Promise((resolve) => setTimeout(() => resolve(timedOut), softDeadlineMs))]);
      if (winner === timedOut) {
        console.warn(`[subconvertion] ${host}: soft deadline hit, serving cache and refreshing in background`);
        ctx.waitUntil(freshPromise.then((f) => f && persistFreshSubscription(f, cached, bucket, cacheKey, host)).catch(() => {}));
        return cacheResult(cached, true);
      }
      fresh = winner;
    }
  }
  fresh ??= await freshPromise;
  const cached = await cachedPromise;
  if (fresh) {
    const suspicious = await persistFreshSubscription(fresh, cached, bucket, cacheKey, host, ctx);
    return { source: 'fresh', parsedObj: fresh.parsedObj, headers: fresh.headers, suspicious, ua: fresh.ua };
  }
  if (isUsable(cached)) {
    console.warn(`[subconvertion] ${host}: using cached subscription (age ${Math.round((Date.now() - cached.cachedAt) / 1000)}s)`);
    return cacheResult(cached, false);
  }
  return { source: 'none' };
}
// A sharp drop (e.g. plan expired, provider glitch) must not overwrite the last good copy,
// unless that copy is old enough that the drop is likely permanent. Returns whether it was suspicious.
async function persistFreshSubscription(fresh, cached, bucket, cacheKey, host, ctx) {
  const { nodeCount } = fresh;
  const suspicious = !!cached && cached.nodeCount >= 5 && nodeCount < cached.nodeCount * 0.3;
  if (suspicious)
    console.warn(`[subconvertion] ${host}: node count dropped ${cached.nodeCount} -> ${nodeCount}`);
  if (!suspicious || Date.now() - cached.cachedAt > SUB_CACHE_REFRESH_MS) {
    const write = writeSubCache(bucket, cacheKey, fresh.text, fresh.headers, nodeCount).catch((e) => console.warn(`[subconvertion] sub cache write failed: ${e}`));
    if (ctx)
      ctx.waitUntil(write);
    else
      await write;
  }
  return suspicious;
}
// Try each UA until one yields usable nodes. Returns { text, headers, parsedObj, nodeCount, ua } or undefined.
async function fetchFreshSubscription(subUrl, init, uaCandidates, host) {
  // All attempts share one deadline so a provider that keeps rejecting cannot stall the request
  const deadline = Date.now() + SUB_FETCH_TIMEOUT_MS * 1.5;
  let fresh;
  for (const ua of uaCandidates) {
    const remaining = Math.min(SUB_FETCH_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0)
      break;
    const headers = new Headers(init.headers);
    if (ua)
      headers.set('User-Agent', ua);
    try {
      // Bound the whole download (headers + body) so a hung provider cannot stall the request
      const response = await fetch(subUrl, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(remaining) });
      if (!response.ok) {
        console.warn(`[subconvertion] Fetch failed: ${host}, UA ${ua}, status: ${response.status}`);
        continue;
      }
      const text = await response.text();
      const parsedObj = parseData(text);
      const nodeCount = countRealNodes(parsedObj);
      if (nodeCount > 0) {
        fresh = { text, headers: response.headers, parsedObj, nodeCount, ua };
        break;
      }
      console.warn(`[subconvertion] No usable nodes from ${host} with UA ${ua}`);
    } catch (error) {
      // Network errors and timeouts do not depend on the UA, so trying others would only add delay
      console.warn(`[subconvertion] Fetch error: ${host}, ${error}`);
      break;
    }
  }
  return fresh;
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
  // The host is part of the key: cached configs embed absolute URLs of this worker (providers, rulesets)
  return CACHE_PREFIX + await sha256Hex(url.host + url.pathname + '?' + new URLSearchParams(params));
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
