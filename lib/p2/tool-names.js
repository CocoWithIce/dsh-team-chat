/**
 * B′ 成员工具名单一常量源 —— lib/p2/tool-names.js
 *
 * t94 · P2 Slice 1b（t93 low-② 收敛）。1a 时工具名字面量散布三处
 * （persona.js / claim-channel.js / spawn.js 白名单），存在双源漂移风险；
 * 本模块是唯一权威出处，其余文件只允许 import，不允许再写字面量。
 * 判别：test/p2-spawn.test.mjs「白名单单一常量源」断言会在有人重新
 * 引入分叉字面量时变红；grep 全 lib/ 无残留字面量由交付证据承载。
 */

/** 成员认领工具名（B′ 白名单通道，宿主侧直调 P1 store）。 */
export const CLAIM_TOOL = 'team_claim_task'
/** 成员回报工具名（B′ 白名单通道，宿主侧直调 P1 store）。 */
export const REPORT_TOOL = 'team_report_task'
/** B′ 全量白名单（注入 request.toolFilter.allow 的唯一来源）。 */
export const MEMBER_TOOL_NAMES = [CLAIM_TOOL, REPORT_TOOL]
