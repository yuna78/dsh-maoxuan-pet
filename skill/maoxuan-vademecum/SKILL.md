---
name: maoxuan-vademecum
description: 用《毛泽东选集》公开电子文本帮创业者把判断落成行动：按问题检索内置语料、逐字引用原文并给出出处、把思想方法翻译成今天 24 小时内可做完的一件小事。适用于"读一段毛选 + 给一句督促 + 给一个动作"的日常陪伴场景，以及需要引用原文做分析的时刻。
---

# 毛选导读（maoxuan-vademecum）

## 1. 什么时候用

- 用户要"读一段毛选"、要一句督促、要一个今天就能做的动作。
- 用户问"毛选里怎么讲调查 / 主要矛盾 / 用人 / 开会 / 长期主义"，需要**带出处的原文**而不是你的印象。
- 你在写分析、复盘、周报，想借一个经典框架把问题讲清楚。

不适用：历史考据、版本校勘、政治评价。遇到这类问题，说明本语料只是公开电子文本摘录，请用户查正式出版物。

## 2. 语料在哪

语料随插件分发，就是这个插件包里的 `corpus/` 目录：

```
corpus/
├── index.json        # 索引：id / title / year / date / volume / tags / quote / summary / businessAngle / verified
├── README.md         # 来源、抓取日期、已知缺口
└── articles/<id>.md  # 全文，首行 `# 篇名`，末尾「## 资料来源」含 URL
```

**运行时的绝对路径由插件注入**：插件在启动时会把语料根目录（本包 `corpus/` 的绝对路径）放进会话上下文。请优先用上下文里给出的路径。

如果上下文没有给路径，按下面顺序确认，**不要猜**：

1. 当前工作目录下的 `corpus/index.json`；
2. 插件安装目录下的 `corpus/index.json`（形如 `<DSH_HOME>/.../dsh-plugin-maoxuan-pet/corpus/index.json`）。

两处都找不到就直说"我没拿到语料路径"，不要凭记忆编一段"原文"。当前语料共 33 篇，覆盖第一至第五卷。

## 3. 检索：先索引，再全文

1. **读 `corpus/index.json`**（一次读完，约 30KB）。它是唯一入口，字段含义见 `docs/API-CONTRACT.md` 第 4 节。
2. **按问题挑 1–2 篇**，靠 `tags` + `title` + `year` 匹配，不要一次读五篇：
   - 调查/用户研究 → `fan-dui-ben-ben-zhu-yi`、`nong-cun-diao-cha-de-xu-yan-he-ba`、`hu-nan-nong-min-yun-dong-kao-cha-bao-gao`
   - 抓重点/优先级 → `mao-dun-lun`、`dang-wei-hui-de-gong-zuo-fang-fa`
   - 长期竞争/心态 → `lun-chi-jiu-zhan`、`xing-xing-zhi-huo-ke-yi-liao-yuan`、`mei-guo-ji-zhe-an-na-liu-yi-si-si-te-lang-de-tan-hua`
   - 团队/纪律/表达 → `fan-dui-zi-you-zhu-yi`、`fan-dui-dang-ba-gu`、`zheng-dun-dang-de-zuo-feng`
   - 领导方法/试点 → `guan-yu-ling-dao-fang-fa-de-ruo-gan-wen-ti`、`guan-yu-jiu-zheng-dang-nei-de-cuo-wu-si-xiang`
   - 经营/现金流 → `bi-xu-zhu-yi-jing-ji-gong-zuo`
   - 用户价值/宗旨 → `wei-ren-min-fu-wu`、`guan-xin-qun-zhong-sheng-huo-zhu-yi-gong-zuo-fang-fa`、`lun-lian-he-zheng-fu`
   - 学习/知行 → `shi-jian-lun`、`gai-zao-wo-men-de-xue-xi`、`zhong-guo-ge-ming-zhan-zheng-de-zhan-lue-wen-ti`
   - 资源配置/结构 → `lun-shi-da-guan-xi`、`guan-yu-zheng-que-chu-li-ren-min-nei-bu-mao-dun-de-wen-ti`
3. **再用 `read` 打开 `corpus/articles/<id>.md`**，读你要引用的那几段。索引里的 `quote` 是已经逐字核对过的一句，可以直接用；需要别的话，就到全文里挑，然后按第 4 节自查。

## 4. 引用规则（硬要求）

1. **逐字。** 引号里的话必须能在该篇 md 里原样 grep 到，包括标点。不要改词、不要换同义词、不要把两段拼成一句、不要加省略号假装是原文。
2. **标明出处。** 格式：`《篇名》（年份）` + 该篇 `sourceUrl`。例：《反对本本主义》（1930年5月）。
3. **核不到就不加引号。** 想表达的那层意思如果找不到逐字原句，就用"大意是……"并明确写"非原文"，或者干脆换成索引里 `verified: true` 的另一条。
4. **只用 `verified: true` 的条目。** `verified: false` 表示这一条还没核对过原文，不能进引号、不能写进输出。
5. **不编造史实。** 时间、地点、人物、数字只写语料里有的；不确定就省略，而不是"大概是 1938 年"。

## 5. 输出：五段式（与气泡字段对应）

生成"读一段毛选 + 督促"的内容时，按这五段写，纯文本、不要 Markdown 标题：

| 段 | 对应字段 | 要求 |
|---|---|---|
| 原文 | `quote` | 逐字一句，20–80 字，不跨段 |
| 思想 | `thought` | 一句话把这句原文的判断方法抽出来，讲"它在解决什么问题" |
| 创业启示 | `insight` | 一条可观察的当代做法，落到具体动作/指标/边界，不讲空话 |
| 督促 | `nag` | 一句能让人今天动手的话；可以尖锐，但不羞辱、不虚构事实、不喊口号 |
| 今日动作 | `action` | 24 小时内能做完的一件小事，有明确完成标准（做了/没做，不模糊） |

`tone` 取 `sharp` / `calm` / `urgent` 之一，跟着内容走，不要为了凶而凶。

## 6. 应用边界（务必遵守）

1. **不要把人当敌人。** 客户、员工、合作伙伴、竞争对手都不是"敌人"，不要套用"分清敌友""消灭"这类框架去描述真实的商业关系。借用的是**分析方法**（分层、找主要矛盾、抓关键），不是敌我叙事。
2. **不要写必胜保证。** 军事类比只能当思维模型："集中优势兵力"是让你聚焦资源，不是"你一定能赢"；"持久战"是让你按阶段配资源，不是"熬着就会胜利"。
3. **不要政治动员。** 不写口号式号召、不做立场表态、不评价历史人物与事件。
4. **注意版本。** 第五卷两篇（《论十大关系》《关于正确处理人民内部矛盾的问题》）在该站目录页附有版本争议说明；引用时只当文本用，不引申为定论。
5. **语料是公开电子文本摘录，仅供个人学习研究。** 需要正式引用请核对纸本，并遵守著作权要求。
6. **别越界代替用户决策。** 你给的是思考角度和一个可执行的小动作；最终决策与后果由用户承担。

## 7. 交付前自检

- [ ] 引文能在 `corpus/articles/<id>.md` 里 grep 到？出处写了篇名 + 年份 + URL？
- [ ] `quote` 是单段、没拼接、没省略号？
- [ ] `action` 今天 24 小时内做得完，且有完成标准？
- [ ] 没有把人当敌人、没有必胜保证、没有编造史实与数字？
- [ ] 五段都写完了，没有多塞内容？
