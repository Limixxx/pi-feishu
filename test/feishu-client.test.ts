/**
 * Task3 验收测试 — pi-feishu 问题 #1 修改点回归
 *
 * 覆盖 M6/M9（错误类型区分）、M10（串行队列 + token bucket 节流）、M9（退避重试）。
 * 由于发送层私有逻辑依赖飞书 SDK，这里直接对被导出的行为做黑盒 / 反射层验证：
 *  - isTransientError 错误分类（驱动进度卡片句柄保留/清空的核心判据）
 *  - FeishuClient 内部串行队列（enqueueSend: sendQueue 链式、QPS 节流 acquireToken 串行化）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuClient, isTransientError } from "../src/feishu-client.js";
import type { FeishuConfig } from "../src/types.js";

// ────────────────────────────────────────────────────
//  配置：测试无需真实 AppId/Secret（不触网，只测纯逻辑）
// ────────────────────────────────────────────────────
const CONFIG: FeishuConfig = {
  appId: "cli_test",
  appSecret: "test_secret",
  domain: "feishu",
};

// ════════════════════════════════════════════════════
//  M9 错误类型区分 —— isTransientError
// ════════════════════════════════════════════════════
test("M6/M9: 暂时性错误（限流）应识别为 transient -> 保留卡片句柄", () => {
  // HTTP 429
  assert.equal(isTransientError({ response: { status: 429 } }), true);
  // body code 9499（FREQUENCY_LIMIT）
  assert.equal(isTransientError({ code: 9499 }), true);
  // 频率类错误码 230020 / 230026
  assert.equal(isTransientError({ code: 230020 }), true);
  assert.equal(isTransientError({ code: 230026 }), true);
  // 响应头 Retry-After
  assert.equal(
    isTransientError({ response: { headers: { "retry-after": "2" } } }),
    true,
  );
  // 响应头 X-Ogw-Ratelimit-Reset
  assert.equal(
    isTransientError({ response: { headers: { "x-ogw-ratelimit-reset": "3" } } }),
    true,
  );
});

test("M6/M9: 服务器 5xx 应识别为 transient", () => {
  assert.equal(isTransientError({ response: { status: 502 } }), true);
  assert.equal(isTransientError({ response: { status: 503 } }), true);
});

test("M6/M9: 网络类错误应识别为 transient", () => {
  assert.equal(
    isTransientError({
      code: null,
      message: "getaddrinfo ENOTFOUND open.feishu.cn",
    }),
    true,
  );
  assert.equal(
    isTransientError({ code: null, message: "socket timeout" }),
    true,
  );
});

test("M6/M9: 永久性错误（消息不存在/已撤回 230002、230011）不应识别为 transient -> 清空句柄", () => {
  // 消息不存在（卡片更新永久失败）
  assert.equal(isTransientError({ code: 230002 }), false);
  // 消息已撤回（回复 fallback 场景）
  assert.equal(isTransientError({ code: 230011 }), false);
  // 普通业务错误 231003
  assert.equal(isTransientError({ code: 231003 }), false);
  // 未知错误
  assert.equal(isTransientError({ code: 9999, message: "some business error" }), false);
  // 无任何限流信息的普通状态 400
  assert.equal(isTransientError({ response: { status: 400 } }), false);
});

// ════════════════════════════════════════════════════
//  M10 串行队列 + token bucket —— enqueueSend 行为
// ════════════════════════════════════════════════════

/**
 * 通过反射访问 FeishuClient 的受保护/私有成员。
 * 不真实触网 —— acquireToken / enqueueSend 与网络无关。
 */
function makeClientInternals(): any {
  // new FeishuClient 会触发 SDK Client 构造，但不连接网络
  const client: any = new FeishuClient(CONFIG);
  // 手动初始化节流现场（等同类构造时状态）
  return client;
}

test("M10: token bucket 默认令牌应等于 QPS 上限（4），初始可立即消耗", async () => {
  const client = makeClientInternals();
  const tokensBefore = client.bucketTokens;
  assert.equal(tokensBefore, 4);
  // acquireToken 立即成功不阻塞
  const t0 = Date.now();
  await client.acquireToken();
  const elapsed = Date.now() - t0;
  assert.equal(client.bucketTokens, 3, "消耗一枚令牌");
  assert.ok(elapsed < 500, "令牌充足时应立即返回，不应阻塞");
});

test("M10: acquireToken 在令牌耗尽后会按节流间隔补令牌（QPS≈4）", async () => {
  const client = makeClientInternals();
  // 耗尽令牌
  await client.acquireToken();
  await client.acquireToken();
  await client.acquireToken();
  await client.acquireToken();
  assert.equal(client.bucketTokens, 0);
  // 下一次 acquireToken 需等待补令牌（间隔 >= SEND_MIN_INTERVAL_MS ≈250ms）
  const t0 = Date.now();
  await client.acquireToken();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 200, `第 5 次应等待补令牌（elapsed=${elapsed}ms）`);
  // 补令牌过程中可能带出部分余量，令牌已耗尽（≤剩余不足 1 枚）
  assert.ok(
    client.bucketTokens < 1,
    `令牌应几乎耗尽（bucketTokens=${client.bucketTokens}）`,
  );
});

test("M10: enqueueSend 将回调串行排队，后一个在前一个 resolve 后才执行", async () => {
  const client = makeClientInternals();
  const order: string[] = [];
  const p1 = client.enqueueSend(async () => {
    await new Promise((r) => setTimeout(r, 150));
    order.push("first");
  });
  const p2 = client.enqueueSend(async () => {
    order.push("second");
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["first", "second"], "串行队列应保证先后顺序");
});

test("M10: enqueueSend 中一个任务失败不应阻塞后续任务", async () => {
  const client = makeClientInternals();
  const order: string[] = [];
  const p1 = client.enqueueSend(async () => {
    order.push("fail-rejected");
    throw new Error("boom");
  });
  const p2 = client.enqueueSend(async () => {
    order.push("still-runs");
  });
  await assert.rejects(() => p1, /boom/);
  await p2;
  assert.ok(order.includes("still-runs"), "前序失败不应阻塞后续发送");
});

test("M9: retryWithBackoff 对非限流错误立即抛出，且对限流做退避重试", async () => {
  const client = makeClientInternals();
  // 非限流错误：不重试，直接抛出（永久错误路径）
  let calls = 0;
  await assert.rejects(() =>
    client.retryWithBackoff(async () => {
      calls++;
      throw { code: 230002 };
    }),
  );
  assert.equal(calls, 1, "永久错误不应重试");

  // 限流错误：退避重试多次（第 1 次限流，之后成功）
  calls = 0;
  const result = await client.retryWithBackoff(async () => {
    calls++;
    if (calls === 1) throw { response: { status: 429, headers: { "retry-after": "0" } } };
    return "ok";
  });
  assert.equal(result, "ok");
  assert.ok(calls >= 2, "限流后应触发退避重试");
});