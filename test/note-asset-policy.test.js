import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createNoteAssetAgents, isPublicAssetAddress } from '../src/note-asset-policy.js';

function resolve(agent, hostname, options = {}) {
  return new Promise((yes, no) => agent.options.lookup(hostname, options, (error, address, family) => {
    if (error) no(error);
    else yes({ address, family });
  }));
}

// 全部使用文档示例地址/合成DNS返回，不进行真实网络访问。
test('仅允许公网IPv4；私网、回环、链路本地、保留与非IP全部拒绝', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '192.0.1.1']) {
    assert.equal(isPublicAssetAddress(address), true, address);
  }
  for (const address of ['0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255', 'localhost', 'localhost.', 'LOCALHOST.', 'api.localhost.', '127.1', '2130706433', '0x7f000001', '', null, {}, ' 8.8.8.8']) {
    assert.equal(isPublicAssetAddress(address), false, String(address));
  }
});

test('IPv6只接受全球单播；拒绝本地/保留/映射和过渡隧道', () => {
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1']) {
    assert.equal(isPublicAssetAddress(address), true, address);
  }
  for (const address of ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:808:808', '::8.8.8.8', '64:ff9b::808:808', '100::1', '2001:db8::1', '2001::1', '2001:20::1', '2002:0808:0808::1', '3fff::1', 'fe80::1%eth0', '[2606:4700::1111]']) {
    assert.equal(isPublicAssetAddress(address), false, address);
  }
});

test('返回原生http/https Agent，lookup强制解析全部地址且支持family/all', async () => {
  const requests = [];
  const agents = createNoteAssetAgents({ lookup(hostname, options, callback) {
    requests.push({ hostname, options });
    callback(null, [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700::1111', family: 6 }]);
  } });
  try {
    assert.ok(agents.httpAgent instanceof http.Agent);
    assert.ok(agents.httpsAgent instanceof https.Agent);
    assert.deepEqual(await resolve(agents.httpAgent, 'assets.example', { family: 6 }), { address: '2606:4700::1111', family: 6 });
    assert.deepEqual(await resolve(agents.httpsAgent, 'assets.example', { family: 'IPv4', all: true }), { address: [{ address: '1.1.1.1', family: 4 }], family: undefined });
    assert.deepEqual(await resolve(agents.httpAgent, 'assets.example', 4), { address: '1.1.1.1', family: 4 });
    assert.deepEqual(requests.map(({ options }) => options), [
      { all: true, family: 0 }, { all: true, family: 0 }, { all: true, family: 0 },
    ]);
  } finally { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); }
});

test('混合公网/私网的DNS响应整批拒绝，不因family筛选绕过', async () => {
  for (const answers of [
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }],
    [{ address: '1.1.1.1', family: 6 }],
    [], [{ address: 'not-ip', family: 4 }],
  ]) {
    const agents = createNoteAssetAgents({ lookup(_host, _options, callback) { callback(null, answers); } });
    try {
      await assert.rejects(resolve(agents.httpAgent, 'assets.example', { family: 4 }), /公网|地址|DNS/);
    } finally { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); }
  }
});

test('localhost尾点/子域和IP字面量在解析入口阻断，不调用DNS', async () => {
  let calls = 0;
  const agents = createNoteAssetAgents({ lookup() { calls += 1; assert.fail('不应查询DNS'); } });
  try {
    for (const host of ['localhost', 'LOCALHOST.', 'api.localhost.', '127.0.0.1', '::1']) {
      await assert.rejects(resolve(agents.httpAgent, host), /公网|本地/);
    }
    assert.deepEqual(await resolve(agents.httpsAgent, '1.1.1.1'), { address: '1.1.1.1', family: 4 });
    assert.equal(calls, 0);
  } finally { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); }
});

test('DNS失败与指定family无结果均明确失败；每次连接重新解析防换绑', async () => {
  let calls = 0;
  const agents = createNoteAssetAgents({ lookup(_host, _options, callback) {
    calls += 1;
    if (calls === 1) callback(null, [{ address: '1.1.1.1', family: 4 }]);
    else callback(null, [{ address: '127.0.0.1', family: 4 }]);
  } });
  try {
    await assert.rejects(resolve(agents.httpAgent, 'assets.example', { family: 6 }), /family|地址/);
    await assert.rejects(resolve(agents.httpAgent, 'assets.example'), /公网|地址/);
    assert.equal(calls, 2);
  } finally { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); }
  const failed = createNoteAssetAgents({ lookup(_host, _options, callback) { callback(Object.assign(new Error('DNS错误'), { code: 'ENOTFOUND' })); } });
  try { await assert.rejects(resolve(failed.httpAgent, 'assets.example'), (error) => error.code === 'ENOTFOUND'); }
  finally { failed.httpAgent.destroy(); failed.httpsAgent.destroy(); }
});
