import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function isLocalhost(hostname) {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

/** 只接受公网IP字面量；域名需在socket实际连接时由下方lookup校验。 */
export function isPublicAssetAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    // 拒绝私有/共享/回环/链路本地、文档/基准测试、组播和未来保留地址。
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // 只允许2000::/3全球单播，从而同时拒绝::、回环、映射、NAT64、ULA及链路本地。
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [firstText, secondText = '0'] = normalized.split(':');
  const first = parseInt(firstText || '0', 16);
  const second = parseInt(secondText || '0', 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  // 保守排除特殊用途2001::/23、文档段、6to4隧道，避免封装地址绕过IPv4策略。
  return !((first === 0x2001 && (second < 0x0200 || second === 0x0db8))
    || first === 0x2002
    || (first === 0x3fff && second < 0x1000));
}

function blockedError(message = '资产DNS包含非公网地址，已拒绝连接。') {
  const error = new Error(message);
  error.code = 'ERR_NOTE_ASSET_ADDRESS_BLOCKED';
  return error;
}

/**
 * 不做“预解析后再次解析”：lookup返回的这一批地址直接供同次socket连接使用。
 * 即使调用方指定family，也必须先检查全部IPv4/IPv6结果，任一非公网则整批拒绝。
 * 依赖注入只用于离线测试；生产默认使用系统dns.lookup，不读取凭据。
 */
export function createNoteAssetAgents({ lookup = dns.lookup } = {}) {
  if (typeof lookup !== 'function') throw new TypeError('资产DNS lookup必须是函数。');
  const safeLookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const settings = typeof options === 'number' ? { family: options } : (options || {});
    const family = settings.family === 'IPv4' ? 4 : settings.family === 'IPv6' ? 6 : (settings.family ?? 0);
    if (![0, 4, 6].includes(family)) {
      queueMicrotask(() => callback(blockedError('资产DNS family参数无效。')));
      return;
    }
    if (typeof hostname !== 'string' || !hostname || hostname !== hostname.trim() || isLocalhost(hostname)) {
      queueMicrotask(() => callback(blockedError('资产本地主机名已拒绝连接。')));
      return;
    }
    const finish = (error, addresses) => {
      if (error) { callback(error); return; }
      if (!Array.isArray(addresses) || addresses.length === 0
        || addresses.some((item) => !isPublicAssetAddress(item?.address) || item.family !== net.isIP(item.address))) {
        callback(blockedError());
        return;
      }
      const selected = addresses.filter((item) => !family || item.family === family)
        .map(({ address, family: recordFamily }) => ({ address, family: recordFamily }));
      if (selected.length === 0) { callback(blockedError('资产DNS缺少指定family的公网地址。')); return; }
      if (settings.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    };
    const literalFamily = net.isIP(hostname);
    if (literalFamily) {
      queueMicrotask(() => finish(null, [{ address: hostname, family: literalFamily }]));
      return;
    }
    // 不透传ADDRCONFIG/V4MAPPED等筛选标志，防止先过滤掉应被拒绝的地址。
    lookup(hostname, { all: true, family: 0 }, finish);
  };
  return {
    httpAgent: new http.Agent({ lookup: safeLookup }),
    httpsAgent: new https.Agent({ lookup: safeLookup }),
  };
}
