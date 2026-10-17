// 自测：oracle 那几套的**等价检查**（纲领 §4.5「测试跟着搬，不重建」）。
//
// Phase 1 的 DoD 点名了四套：设置 / 背景图 / env / Key 不外漏。
// 它们各自对应一个真被审计出来的静默失效：
//   · 设置  —— 提供商显示名被写成 id（左侧列表整列显示成 deepseek，用户认不出谁是谁）；
//              以及"拿网址去调 openPath"那个把链接弄坏的 bug。
//   · 背景图 —— 导入失败把旧图弄丢、导入自己把目录清空（两个实测 P0）。
//   · env    —— .env 里的 Key 被写回配置文件（"放在应用配置之外"就白说了）。
//   · Key    —— 明文 Key 从导出或"发给渲染进程的设置"里漏出去（审计实测过）。
//
// 判据一律**断言数字/字段**，不断言"程序自报的布尔"（Phase 0 交叉审查的结论：
// 通过条件如果就是被测程序自己算的那个布尔，那这一条等价于"它说它对"）。
#pragma once

#include <string>

#include "../util/json_util.h"

namespace isg {

/* 无窗口自测。name 取 settings / background / env / key-leak / bridge / keycompat / protocol。
   返回退出码（0 = 全过，1 = 有判据没过，2 = 自测自己出错）。 */
int selftest_run_headless(const std::string& name, const std::wstring& reportPath);

/* 需要在**真页面**里跑的脚本（`--selftest=ui` 用）。
   脚本里有一处 `__ISG_PROBE_HTML__` 占位符，由宿主替换成"已放行的探针页路径"。 */
const std::string& selftest_ui_script();

/* `--selftest=pipeline-mock`：在真页面里把整条流水线对着本地假模型跑一遍。
   占位符 `__ISG_PIPELINE_FIXTURE__` / `__ISG_PIPELINE_OUT__` 由宿主替换。 */
const std::string& selftest_pipeline_script();

/* `--selftest=net-fault`：SSE 切包 / 400 降级 / 429 重试的端到端检查。 */
const std::string& selftest_net_script();

/* `--selftest=pipeline-cancel`：在模型调用进行中取消，断言任务在几秒内变成 canceled。 */
const std::string& selftest_cancel_script();

/* `--selftest=verify`：真页面跑探针 + demo 读数核对（含"改坏一页必须报错"的反例）。
   占位符 __VERIFY_GOOD__ / __VERIFY_BAD__ / __VERIFY_TINY__。 */
const std::string& selftest_verify_script();

/* `--selftest=book`：book:* 三个通道 + carry 的失败路径。
   占位符 __BOOK_SIDE__ / __BOOK_PLAIN__ / __BOOK_JUNK__ / __BOOK_SECRET__ / __BOOK_MD__。 */
const std::string& selftest_book_script();

/* `--selftest=book-e2e`：真跑两次生成（第 2 次把第 1 章带进一册）。
   占位符 __ISG_PIPELINE_FIXTURE__ / __ISG_PIPELINE_OUT__。 */
const std::string& selftest_book_e2e_script();

/* `--selftest=multi-source`：两份来源（courseware + exampaper）独立分析后融合，
   产出里要能看到真题分析的哨兵 `MARK-EXAM`。占位符 __MS_FIXTURE1__ / __MS_FIXTURE2__ / __MS_OUT__。 */
const std::string& selftest_multi_source_script();

}  // namespace isg
