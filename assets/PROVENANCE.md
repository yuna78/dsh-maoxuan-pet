# 素材来源与生成记录（PROVENANCE）

**素材性质：DeepSeek 民间同人形象「鲸鱼娘·小毛」——非官方素材，AI 生成。**
与 DeepSeek 官方无任何关联，仅作本插件（dsh-plugin-maoxuan-pet）的宠物形象使用。

- 角色设定（用户原话）：「画一个鲸鱼娘（deepseek 的民间 ip）…… 传中国的红军的制服…… 因为要读毛选，手里有毛选的书」。
- 生成日期：**2026-10-31**（America/New_York）。
- 生成模型：**gpt-image-2**，通过用户自建的中转线路调用（`POST /v1/images/generations` 文生图、`POST /v1/images/edits` 图生图 / 表情差分，图生图请求带 `background=transparent`）。
- 生成工具：
  - 文生图：作者本机的一个 `gen_image.py` 脚本（个人 skill 目录，非本仓库代码，未随包分发）。
  - 图生图 / 表情差分：临时 multipart 脚本（仅标准库，未入库），调用同一中转的 `/v1/images/edits`。
- 凭据处理：base URL / 模型名 / API key 全部经**环境变量**传入，未写入本仓库任何文件、日志或提交。本文件不含任何 key。
- 后处理：系统自带 `python3` + Pillow（12.1.0）+ numpy，脚本为临时脚本（未入库）。未安装任何新的系统依赖。

## 生成流程

1. **定角色**：文生图一张 1024×1536 的站姿「抱书微笑」立绘（`assets/raw/idle-v1.png`）。
2. **定封面文字**：以该立绘为参考做图生图，只改「红封面上的竖排中文」，并直接要求 `background=transparent`，得到带 alpha 的 idle 底帧（`assets/raw/idle-text-v2.png`）。
3. **做表情/姿势差分**：全部以 idle 底帧为参考做图生图，保持角色、服装、比例、配色、封面题字不变，只改表情或持书方式，输出仍为透明底：
   - talk → `assets/raw/talk-final.png`
   - blink → `assets/raw/blink-final.png`
   - read → `assets/raw/read-v3.png`
4. **统一画面**：四帧用**同一个裁剪框**（原图 1024×1536 的 `(160, 0, 880, 1516)`）裁切，先把透明区域外扩成相邻像素颜色（避免缩放时白边渗入轮廓），再 Lanczos 等比缩放到 **640×1348** 作为母版；交付版再降到 **256×539**（UI 展示高 132px，2x 屏幕够用，四帧共用同一画布与脚底线，切换帧时身体不跳）。
5. `assets/icon.svg`：**手写 SVG**（纯几何形状，非 AI 生成），米白底 + 红皮书 + 烫金五角星与书名条，2326 字节；另导出 `assets/icon-256.png`（256×256 RGBA）供市场条目 `icon:` 使用（市场只收 GitHub 托管位图，不收 SVG）。

原始中间产物保留在 `assets/raw/`（本仓库 `.gitignore` 已忽略该目录，不随 git 提交；如需瘦身可直接删除）。

## 每个文件的 prompt 全文

### 1. `assets/pet-idle.png`（站姿抱书微笑）

第一步（文生图，1024×1536）：

> a cute chibi anime girl mascot based on a whale: deep navy-blue short bob hair with two small whale-fin shaped hair ornaments, a small blue whale tail fin peeking behind her back, big round dark-blue eyes, fair skin, cheerful, wearing an authentic 1920s-1930s Chinese Workers and Peasants Red Army uniform: grey-blue coarse cotton tunic with red collar tabs, a red cloth armband on the left upper arm, a grey-blue octagonal cloth cap with a small red five-pointed star on the front, grey-blue cloth trousers with puttees, black cloth shoes, holding a thick hardcover book hugged against her chest with both hands; the book cover is plain solid red with one subtle embossed small five-pointed star, the cover has NO text and NO letters, standing upright facing the viewer, gentle warm smile, mouth closed, clean 2D anime key-visual illustration, flat color with thin crisp lineart and soft cel shading, warm cozy palette, full body, centered, pure solid flat white background #FFFFFF, absolutely no shadow under the feet, no gradient, no frame, no text, no letters, no watermark, no 3D, not photorealistic

第二步（图生图表情/题字，`background=transparent`）：

> Same image, same character, fully transparent background. Only change: on the plain red front cover of the book, write the five Chinese characters 毛泽东选集 in warm off-white printed Chinese type, stacked vertically top to bottom, small, narrow, placed in the UPPER LEFT part of the red cover well above her hand so no character is covered by her hand or arm. Keep EXACTLY the same character, face design, hair, hat with red star, uniform, red armband, palette, lineart style, scale and framing. No shadows. Do not draw any text on the armband or clothing.

### 2. `assets/pet-talk.png`（张嘴说话，供气泡同步）

> Same character, same pose. Only her expression changes: mouth open mid-sentence speaking warmly, bright friendly eyes, slightly raised chin. Keep EXACTLY the same character, hair, hat with red star, uniform, red armband, the red book with the vertical Chinese title on its cover, palette, lineart style, scale and framing. Fully transparent background, no shadows, no text on clothing.

### 3. `assets/pet-blink.png`（闭眼/眨眼，与 idle 交替播放）

> Same character, same pose. Only her expression changes: eyes gently closed in a happy relaxed blink (curved eyelashes), mouth closed in a soft smile. Keep EXACTLY the same character, hair, hat with red star, uniform, red armband, the red book with the vertical Chinese title on its cover, palette, lineart style, scale and framing. Fully transparent background, no shadows, no text on clothing.

### 4. `assets/pet-read.png`（低头看书）

> Same character, same hat, same uniform, same red armband, same art style and scale, fully transparent background. Pose change: she lowers her head and looks DOWN at the red book, which she now holds OPEN in both hands so we can see the warm white printed pages with neat vertical lines of tiny abstract Chinese text; the red cover with the five-pointed star stays visible under the pages; calm focused smile. Keep exactly the same character design, hair, face, hat with red star, palette, lineart. No shadows, no extra text on her clothing.

## 实际交付与检查结果（真实执行）

| 文件 | 像素 | 色彩/通道 | `file` 输出 | 说明 |
| --- | --- | --- | --- | --- |
| `assets/pet-idle.png` | 256×539 | RGBA，带 alpha | PNG image data, 256 x 539, 8-bit/color RGBA, non-interlaced | 站姿抱书微笑，封面竖排「毛泽东选集」可辨 |
| `assets/pet-talk.png` | 256×539 | RGBA，带 alpha | 同上 | 同姿势张嘴说话，封面题字保留（字号比 idle 略小、略挤） |
| `assets/pet-blink.png` | 256×539 | RGBA，带 alpha | 同上 | 闭眼微笑，与 idle 仅表情不同 |
| `assets/pet-read.png` | 256×539 | RGBA，带 alpha | 同上 | 低头看书，书摊开（见下方缺陷第 2 条） |
| `assets/icon.svg` | viewBox 512×512，2326 字节 | 纯几何矢量 | — | 米白底 + 红皮书 + 烫金五角星 + 书名条，手写；同款导出为 `assets/icon-256.png` |

每张 PNG 都用 `read_image` 逐张看过后才采用；另外把四帧合成到棋盘格背景上放大检查轮廓边缘，确认透明通道有效、无白色描边、脚底与发梢没有被裁断。

## 缺陷与局限（如实记录）

1. **封面中文是模型直接画出来的**，不是后期叠加：
   - idle / blink / talk 三帧的红封面上，竖排「毛泽东选集」五字可辨；其中 talk 帧字号偏小、字距略挤，远看仍可读但不如 idle 干净（单张重试 3 次上限内未再重生成）。
   - **read 帧的书是摊开的**，封面题字被书页遮住，因此该帧封面只保留五角星与米白书页上的抽象竖排小字，**没有可读的「毛泽东选集」字样**。若需要四帧都出现完整书名，需要前端在 read 帧叠加 SVG 文字。
2. **制服**：帽子形制接近 1930 年代红军软帽/八角帽（正面红五星清晰、灰蓝土布质感），但帽檐比历史实物更挺括、略偏「军帽」感；红领章在 idle/talk/blink 是三角形小领章、在 read 帧是菱形块，帧间不完全一致。没有出现国民政府军、现代迷彩、纳粹/苏联符号。
3. **手部**：四帧都是双手抱书或持书，手指被简化为四指团块（Q 版常见处理），没有出现多余手指或明显畸形，但也没有逐指分开。
4. **鞋**：黑色布鞋鞋面上有一块肉色椭圆（脚背），放大看略像「鞋面开孔」，属轻微造型瑕疵。
5. **帧间一致性**：四帧由同一底图 img2img 派生，构图、比例、配色、服装基本一致，但发梢分叉、鲸尾弯曲、腰带扣、领章形状等有细小差别。**不适合做逐像素动画**，只适合静态帧切换（插件里 idle↔blink 交替、talk 气泡同步、read 展示的用法）。
6. 生成过程记录：blink 第一次透明底请求（`raw/blink-v2.png`）返回的是不带 alpha 的 RGB，已重新生成（`raw/blink-final.png`）；read 第一版（`raw/read-v2.png`）帽形/领章与 idle 差异偏大，改用第二版（`raw/read-v3.png`）。
7. 全部素材无第三方素材、无水印、无多余文字；`icon.svg` 为手写纯几何图形。

## 复现方式（不含任何密钥）

```bash
export GPT_IMAGE_BASE_URL="<用户自己的 OpenAI 兼容中转地址>"
export GPT_IMAGE_MODEL="gpt-image-2"
export GPT_IMAGE_API_KEY="<从用户私有的 key 文件按环境变量注入>"

# 1) 文生图底图
python3 ~/.codex/skills/gpt-image/scripts/gen_image.py --size 1024x1536 \
  --prompt "<见上文 idle 第一步 prompt>" --output assets/raw/idle-v1.png

# 2) 表情/姿势差分：POST {GPT_IMAGE_BASE_URL}/images/edits（multipart）
#    image=assets/raw/idle-text-v2.png, background=transparent, size=1024x1536
#    prompt=<见上文各帧 prompt>

# 3) 统一裁剪 640×1348 母版、透明区域颜色外扩、Lanczos 缩放（Pillow）
# 4) 交付版再等比降到 256×539，PNG optimize=True（四帧共 603 KB，0.2.1 起）
```
