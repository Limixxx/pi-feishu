/**
 * 服务验证加载冒烟测试：确认修改后的模块可被正常加载与实例化。
 *
 * pi-feishu 是 pi 扩展（源码被 pi 通过 jiti 直载），无独立 HTTP/MCP 服务。
 * 服务验证等价于：模块加载无报错 + 核心客户端可实例化 + 关键导出函数行为正确。
 */
import { FeishuClient, isTransientError } from "../src/feishu-client.js";

const results: string[] = [];

try {
  const client = new FeishuClient({ appId: "cli_test", appSecret: "x", domain: "feishu" });
  results.push(`FeishuClient 实例化: ${client instanceof FeishuClient ? "ok" : "error"}`);
} catch (e) {
  results.push(`FeishuClient 实例化: error -> ${(e as Error).message}`);
}

// 关键导出函数行为
results.push(`isTransientError(9499 限流) 应为 true: ${isTransientError({ code: 9499 })}`);
results.push(`isTransientError(230002 永久) 应为 false: ${isTransientError({ code: 230002 })}`);

console.log("=== 服务加载验证 ===");
for (const r of results) console.log(" -", r);