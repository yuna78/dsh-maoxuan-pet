# 毛选公开语料包（corpus/）

本目录是插件 `dsh-plugin-maoxuan-pet` 的内置语料，供 Host 生成气泡时取用，也供 preset 会话里的 agent 用 `read` 工具通读全文。

## 一、来源与版权

- 唯一数据来源：**中文马克思主义文库 · 毛泽东**
  <https://www.marxists.org/chinese/maozedong/index.htm>
- 全部正文均为**真实抓取**所得（`scripts/fetch-corpus.mjs`，Node ≥ 20，无第三方依赖），
  未凭记忆补写任何一句"原文"；抓不到的篇目记录为缺口，不写入语料。
- 部分页面为 GB2312 编码，抓取时统一用 `gb18030` 解码。
- **仅供个人学习、研究使用。** 著作权归原作者及原出版方；本目录不构成任何形式的再出版或商业授权。
  如需在商业场景中公开引用，请自行核对正式出版物并取得授权。

## 二、版本与生成方式

| 项 | 值 |
|---|---|
| `index.json` 的 `version` | 1（契约字段见 `docs/API-CONTRACT.md` 第 4 节） |
| `edition` | 据中文马克思主义文库公开电子文本整理 |
| 抓取日期 | 2026-10-31（本地日期，见每篇 md 末尾「资料来源」段） |
| 条目数 | **33 篇 / 33 篇已核验**（`verified: true`） |
| 覆盖卷次 | 第一至第五卷 |
| 总大小 | 约 1.2 MB |
| 抓取失败 | **0 篇** |

重新生成（幂等，已有 md 默认跳过）：

```bash
node scripts/fetch-corpus.mjs            # 抓取缺失篇目并重建 index.json
node scripts/fetch-corpus.mjs --force    # 强制重抓全部
node scripts/fetch-corpus.mjs --offline  # 不联网，仅用已有 md 重建 index.json 并复核引文
node scripts/fetch-corpus.mjs --limit 2  # 调试：只处理前 2 篇
node scripts/fetch-corpus.mjs --only fan-dui-ben-ben-zhu-yi ...   # 调试：只处理指定 id
```

编辑元数据（`quote` / `summary` / `businessAngle` / `tags`）只改 `scripts/corpus-meta.json`，
不要直接改 `index.json`——它是脚本产物。脚本会把 `quote` 拿去和落盘的 md 正文做**逐字包含**校验，
校验不过就写 `verified: false` 且清空 `quote`，绝不把没核对过的引文交给生成流程。

## 三、目录结构

```
corpus/
├── README.md          # 本文件
├── index.json         # 语料索引（契约字段），脚本生成
├── .catalog.json      # 目录页解析缓存（329 篇篇目），供 --offline 校验用
└── articles/          # 33 篇全文 markdown，首行 `# 篇名`，末尾附「资料来源」
    └── <id>.md
```

每篇 md 的结构：`# 篇名` → 原文日期行（形如 `*（一九三○年五月）*`）→ 正文（按自然段分节，
章节小标题渲染为 `## `）→ `## 资料来源`（篇名、来源、URL、抓取日期、使用说明）。

## 四、条目清单

| 卷 | 篇名 | 原文日期 | id |
|---|---|---|---|
| 第一卷 | 中国社会各阶级的分析 | 1925年12月 | `zhong-guo-she-hui-ge-jie-ji-de-fen-xi` |
| 第一卷 | 湖南农民运动考察报告 | 1927年3月 | `hu-nan-nong-min-yun-dong-kao-cha-bao-gao` |
| 第一卷 | 中国的红色政权为什么能够存在？ | 1928年10月5日 | `zhong-guo-de-hong-se-zheng-quan-wei-shi-me-neng-gou-cun-zai` |
| 第一卷 | 关于纠正党内的错误思想 | 1929年12月 | `guan-yu-jiu-zheng-dang-nei-de-cuo-wu-si-xiang` |
| 第一卷 | 星星之火，可以燎原 | 1930年1月5日 | `xing-xing-zhi-huo-ke-yi-liao-yuan` |
| 第一卷 | 反对本本主义 | 1930年5月 | `fan-dui-ben-ben-zhu-yi` |
| 第一卷 | 必须注意经济工作 | 1933年8月12日 | `bi-xu-zhu-yi-jing-ji-gong-zuo` |
| 第一卷 | 关心群众生活，注意工作方法 | 1934年1月27日 | `guan-xin-qun-zhong-sheng-huo-zhu-yi-gong-zuo-fang-fa` |
| 第一卷 | 实践论 | 1937年7月 | `shi-jian-lun` |
| 第一卷 | 矛盾论 | 1937年8月 | `mao-dun-lun` |
| 第一卷 | 中国革命战争的战略问题 | 1936年12月 | `zhong-guo-ge-ming-zhan-zheng-de-zhan-lue-wen-ti` |
| 第二卷 | 反对自由主义 | 1937年9月7日 | `fan-dui-zi-you-zhu-yi` |
| 第二卷 | 论持久战 | 1938年5月 | `lun-chi-jiu-zhan` |
| 第二卷 | 战争和战略问题 | 1938年11月6日 | `zhan-zheng-he-zhan-lue-wen-ti` |
| 第二卷 | 五四运动 | 1939年5月1日 | `wu-si-yun-dong` |
| 第二卷 | 青年运动的方向 | 1939年5月4日 | `qing-nian-yun-dong-de-fang-xiang` |
| 第二卷 | 纪念白求恩 | 1939年12月21日 | `ji-nian-bai-qiu-en` |
| 第三卷 | 《农村调查》的序言和跋 | 1941年3月、4月 | `nong-cun-diao-cha-de-xu-yan-he-ba` |
| 第三卷 | 改造我们的学习 | 1941年5月19日 | `gai-zao-wo-men-de-xue-xi` |
| 第三卷 | 整顿党的作风 | 1942年2月1日 | `zheng-dun-dang-de-zuo-feng` |
| 第三卷 | 反对党八股 | 1942年2月8日 | `fan-dui-dang-ba-gu` |
| 第三卷 | 关于领导方法的若干问题 | 1943年6月1日 | `guan-yu-ling-dao-fang-fa-de-ruo-gan-wen-ti` |
| 第三卷 | 为人民服务 | 1944年9月8日 | `wei-ren-min-fu-wu` |
| 第三卷 | 论联合政府 | 1945年4月24日 | `lun-lian-he-zheng-fu` |
| 第三卷 | 愚公移山 | 1945年6月11日 | `yu-gong-yi-shan` |
| 第四卷 | 抗日战争胜利后的时局和我们的方针 | 1945年8月13日 | `kang-ri-zhan-zheng-sheng-li-hou-de-shi-ju-he-wo-men-de-fang-zhen` |
| 第四卷 | 和美国记者安娜·刘易斯·斯特朗的谈话 | 1946年8月6日 | `mei-guo-ji-zhe-an-na-liu-yi-si-si-te-lang-de-tan-hua` |
| 第四卷 | 目前形势和我们的任务 | 1947年12月25日 | `mu-qian-xing-shi-he-wo-men-de-ren-wu` |
| 第四卷 | 将革命进行到底 | 1948年12月30日 | `jiang-ge-ming-jin-xing-dao-di` |
| 第四卷 | 党委会的工作方法 | 1949年3月13日 | `dang-wei-hui-de-gong-zuo-fang-fa` |
| 第四卷 | 论人民民主专政 | 1949年6月30日 | `lun-ren-min-min-zhu-zhuan-zheng` |
| 第五卷 | 论十大关系 | 1956年4月25日 | `lun-shi-da-guan-xi` |
| 第五卷 | 关于正确处理人民内部矛盾的问题 | 1957年2月27日 | `guan-yu-zheng-que-chu-li-ren-min-nei-bu-mao-dun-de-wen-ti` |

## 五、已知缺口与局限（如实记录）

1. **并非全集。** 目录页解析出 329 篇篇目，本包按"与创业/决策/组织最相关"优先收录 33 篇。
   未收录的经典包括《中国革命和中国共产党》《新民主主义论》《在延安文艺座谈会上的讲话》
   《组织起来》《学习和时局》等——它们在目录页里确实存在，只是不在本轮白名单中，
   需要时把它们加进 `scripts/corpus-meta.json` 再跑一次脚本即可。
2. **未收录"未删节本"。** 目录页上以〔未删节本〕标注的版本是独立页面，本包一律收官方通行版；
   《五四运动》《纪念白求恩》等页面正文里出现的兄弟篇目链接文字已在抓取时剔除。
3. **脚注未收录。** 页尾《注释》区在抓取时被整体丢弃，正文中的脚注角标（`[1]`）也已去除，
   因此每段正文是连续的、可以逐字 grep 的文本，但读者看不到注释。
4. **每篇只人工核对一条 `quote`。** `verified: true` 的含义是"该条的 quote 逐字出现在该篇 md 正文中"，
   不等于全篇逐字校勘；原页面可能存在的错字、异体字、标点差异未与纸本核对。
5. **第五卷两篇的文本争议。** 目录页对《论十大关系》《关于正确处理人民内部矛盾的问题》附有
   学者关于 1977 年官方版文本曾被修改的说明。本包采用该站提供的文本，**未与其他版本作比对**，
   引用这两篇时请自行留意版本差异。
6. **生成流程只用 `quote` + `summary` + `businessAngle`。** 全文留给 preset 会话里的 agent 读取；
   `verified: false` 的条目不进入生成 prompt（当前无此类条目）。

## 六、校验

```bash
# 1) 重建索引并复核引文（不联网，只读已有 md）
node scripts/fetch-corpus.mjs --offline

# 2) 逐条检查契约字段，并逐条确认 quote 真的能在对应 md 正文里逐字找到
node scripts/check-corpus.mjs
```

`check-corpus.mjs` 的判定是硬条件：`quote` 必须 `md.includes(quote)`，否则该条不合格、退出码 1。
也就是说，「凭记忆写一段像原文的话」在这里必然失败。
