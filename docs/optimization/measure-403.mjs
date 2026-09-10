#!/usr/bin/env node
// dsh-team-chat 鉴权拒绝路径（403）往返延迟采样 —— t9 浏览器实测的补充旁证
// 用法: node docs/optimization/measure-403.mjs
// 结论标注: 这是「鉴权拒绝路径」延迟，不是真实 /state handler 延迟（handler 未执行）。
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 43120;
const PATH = '/plugins/dsh-team-chat/state';

function probe(path, method = 'GET') {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.request({ host: HOST, port: PORT, path, method, headers: { 'cache-control': 'no-store' } }, (res) => {
      res.resume();
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ status: res.statusCode, ms: Math.round(ms * 100) / 100 });
      });
    });
    req.on('error', (e) => resolve({ err: String(e) }));
    req.end();
  });
}

const N = 10;
const samples = [];
for (let i = 0; i < N; i++) samples.push(await probe(PATH));
const variantSession = await probe(`${PATH}?sessionId=7f017fe8-7529-4a36-afd1-0bb07b506312`);
const variantHead = await probe(PATH, 'HEAD');
const variantRoot = await probe('/');

const msArr = samples.map((x) => x.ms).sort((a, b) => a - b);
const median = msArr[Math.floor(msArr.length / 2)];

console.log('=== 403 拒绝路径往返延迟（10 次采样）===');
for (const s of samples) console.log(`${s.status}  ${s.ms} ms`);
console.log(`median=${median} ms  min=${msArr[0]} ms  max=${msArr[msArr.length - 1]} ms`);
console.log('\n=== 变体 ===');
for (const [name, v] of Object.entries({ sessionId: variantSession, HEAD: variantHead, root: variantRoot })) {
  console.log(`${name}: ${v.status ?? v.err} ${v.ms ?? ''} ms`);
}