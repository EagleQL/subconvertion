import jsYaml from 'js-yaml';

const src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.origin;
    const frontendUrl = 'https://raw.githubusercontent.com/bulianglin/psub/main/frontend.html';
    const SUB_BUCKET = env.SUB_BUCKET;
    let backend = env.BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
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
      backend = backendParam.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const replacements = {};
    const replacedURIs = [];
    const keys = [];

    if (urlParam.startsWith("proxies:")) {
      const { format, data } = parseData(urlParam.replace(/\|/g, "\r\n"));
      if ("yaml" === format) {
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
      let response, parsedObj;

      for (const url2 of urlParts) {
        const key = generateRandomStr(11);
				// e.g.  https://api.xyz.com/?suffix=abc, we need to get 'abc' as the suffix
				let suffix = url.searchParams.get('suffix') || '';
        if (url2.startsWith("https://") || url2.startsWith("http://")) {
					suffix = new URL(url2).searchParams?.get('suffix') || suffix;
          response = await fetch(url2, {
            method: request.method,
            headers: request.headers,
            redirect: 'follow', // https://developers.cloudflare.com/workers/runtime-apis/request#constructor
          });
          if (!response.ok)
            continue;
          const plaintextData = await response.text();
          parsedObj = parseData(plaintextData);
          await SUB_BUCKET.put(key + "_headers", JSON.stringify(Object.fromEntries(response.headers)));
          keys.push(key);
        } else {
          parsedObj = parseData(url2);
        }
        if (/^(ssr?|vmess1?|trojan|vless|hysteria):\/\//.test(url2)) {
          const newLink = replaceInUri(url2, replacements, false);
          if (newLink)
            replacedURIs.push(newLink);
          continue;
        } else if ("base64" === parsedObj.format) {
          const links = parsedObj.data.split(/\r?\n/).filter((link) => link.trim() !== "");
          const newLinks = [];
          for (const link of links) {
            const newLink = replaceInUri(link, replacements, false, suffix);
            if (newLink)
              newLinks.push(newLink);
          }
          const replacedBase64Data = btoa(newLinks.join("\r\n"));
          if (replacedBase64Data) {
						// 将脱敏后的数据暂存到 KV 中
            await SUB_BUCKET.put(key, replacedBase64Data);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        } else if ("yaml" === parsedObj.format) {
          const replacedYAMLData = replaceYAML(parsedObj.data, replacements, suffix);
          if (replacedYAMLData) {
            await SUB_BUCKET.put(key, replacedYAMLData);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        }
      }
    }

		// 请求 subConverter 模版转换端点API，获取转换后的数据
    const newUrl = replacedURIs.join("|");
    url.searchParams.set("url", newUrl);
    const modifiedRequest = new Request(backend + url.pathname + url.search, request);
    const rpResponse = await fetch(modifiedRequest);
    for (const key of keys) {
      await SUB_BUCKET.delete(key);
      await SUB_BUCKET.delete(key + "_headers");
    }
    if (rpResponse.status === 200) {
			// 生成一些假的节点数据，避免客户端报错. 节点格式: {name: 香港-placeholder, server: wb.kaiqsz.com, port: 47119, type: trojan, password: 8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake, sni: mm1.redapricotcloud.com, 'skip-cert-verify': true, udp: true}
			// 常见地区每个地区一个节点, 地区: 美国,日本,新加坡,香港,德国,荷兰,澳大利亚,加拿大,土耳其,越南,英国,台湾,韩国,印度,法国
			const placeholderNodes = getPlaceholderNodes();

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
				for (const node of placeholderNodes) {
					newLinks.push(`trojan://${node.server}:${node.port}?allowInsecure=1&peer=${node.server}&sni=${node.sni}#${node.name}`);
				}
        const replacedBase64Data = btoa(newLinks.join("\r\n"));
        return new Response(replacedBase64Data, rpResponse);
      } catch (base64Error) {
        let result = plaintextData.replace(
          new RegExp(Object.keys(replacements).join("|"), "g"),
          (match) => replacements[match] || match
        );
				// 此处拿到的可能是yaml数据,如果是yaml数据,则把placeholderNodes添加到yaml数据中的proxies字段中
				try {
					const config = jsYaml.load(result);
					if (!config.proxies) {
						config.proxies = [];
					}
					const placeholderNode = {name: '🚫 无可用节点', server: 'a.com', port: 47119, type: 'trojan', password: '8e3ff4d9-79c7-4bcc-a6d6-46f8795ffake', sni: 'b.com', 'skip-cert-verify': true, udp: true};
					config.proxies.push(placeholderNode);
					// 检查所有的proxy-groups, 如果哪个proxy-group下的proxies字段为空或者只包含DIRECT,则添加一个假的节点
					if (config["proxy-groups"]) {
						config["proxy-groups"].forEach((group) => {
							if(!group.proxies) {
								group.proxies = [];
							}
							if (group.proxies.length === 1 && group.proxies[0] === "DIRECT") {
								// remove it first
								group.proxies = [];
							}
							if (group.proxies.length === 0) {
								group.proxies.push(placeholderNode.name);
							}
						});
					}
					const resultNew = jsYaml.dump(config);
					return new Response(resultNew, rpResponse);
				} catch (error) {
					// 如果不是yaml数据,则直接返回
					return new Response(result, rpResponse);
				}
      }
    }
    return rpResponse;
  }
};
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
			result = replaceHysteria(link, replacements);
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
function replaceHysteria(link, replacements) {
  const regexMatch = link.match(/hysteria:\/\/(.*):(.*?)\?/);
  if (!regexMatch) {
    return;
  }
  const server = regexMatch[1];
  const randomDomain = generateRandomStr(12) + ".com";
  replacements[randomDomain] = server;
  return link.replace(server, randomDomain);
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
