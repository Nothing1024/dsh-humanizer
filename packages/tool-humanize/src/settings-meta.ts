/**
 * The plugin's configurable fields as plain data, shared by the host Config (./settings.ts builds
 * the schemastery schema from it) and the browser settings page (src/client/settings), so labels,
 * limits and defaults cannot drift apart. No imports: safe for both bundles.
 * @module dsh-tool-humanize/settings-meta
 */

export type FieldKind = 'text' | 'int' | 'float' | 'bool' | 'list'

/** Where a field lives on the settings page. */
export type SectionId = 'connection' | 'common' | 'limits' | 'checks' | 'sampling' | 'network' | 'tool'

/** How the page edits a field. */
export type Control = 'text' | 'segmented' | 'chips' | 'switch' | 'stepper' | 'slider' | 'number' | 'duration'

export interface Copy {
  label: string
  /** One short line under the control. */
  hint: string
  /** Longer explanation behind the ⓘ button (optional). */
  detail?: string
}

export interface FieldMeta {
  /** Dotted key (`sampling.top_p`); also the settings form field id. */
  key: string
  /** Object path inside the plugin's config section. */
  path: readonly string[]
  kind: FieldKind
  section: SectionId
  control: Control
  default: string | number | boolean | readonly string[]
  min?: number
  max?: number
  /** Slider/stepper step in display units. */
  step?: number
  /** Stored value = display value × scale (ms shown as s or min). */
  scale?: number
  unit?: { zh: string; en: string }
  /** Regex source the value must match (text fields). */
  pattern?: string
  /** Part of the evaluated decoding setup ("恢复官方默认" resets these). */
  official?: boolean
  zh: Copy
  en: Copy
}

export interface SectionMeta { id: SectionId; advanced: boolean; zh: Copy; en: Copy }

export const SECTIONS: readonly SectionMeta[] = [
  { id: 'connection', advanced: false, zh: { label: '连接', hint: '改写模型所在的 llama-server' }, en: { label: 'Connection', hint: 'The llama-server running the humanizer model' } },
  { id: 'common', advanced: false, zh: { label: '常用', hint: '面板和智能体工具的默认行为' }, en: { label: 'General', hint: 'Defaults for the panel and the agent tool' } },
  { id: 'limits', advanced: true, zh: { label: '分段与长度', hint: '长文怎样切成段落改写' }, en: { label: 'Chunking & length', hint: 'How long drafts are cut into pieces' } },
  { id: 'checks', advanced: true, zh: { label: '质量检查', hint: '照抄、语言漂移与保留词的自动重采样' }, en: { label: 'Quality checks', hint: 'Automatic resampling on copying, language drift and lost terms' } },
  { id: 'sampling', advanced: true, zh: { label: '采样参数', hint: '模型按官方评测值采样' }, en: { label: 'Sampling', hint: 'The model samples with the officially evaluated values' } },
  { id: 'network', advanced: true, zh: { label: '超时与重试', hint: '请求等待多久、失败后重试几次' }, en: { label: 'Timeouts & retries', hint: 'How long to wait and how often to retry' } },
  { id: 'tool', advanced: true, zh: { label: '智能体工具', hint: '智能体看到的工具' }, en: { label: 'Agent tool', hint: 'The tool the agent sees' } },
]

const URL_PATTERN = '^https?://[^\\s/?#]+(?:/[^\\s?#]*)?$'
const ENV_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$'
const TOOL_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
const SEC = { zh: '秒', en: 's' }
const MIN = { zh: '分钟', en: 'min' }

function f(key: string, kind: FieldKind, section: SectionId, control: Control, def: FieldMeta['default'], zh: Copy, en: Copy, extra: Partial<FieldMeta> = {}): FieldMeta {
  return { key, path: key.split('.'), kind, section, control, default: def, zh, en, ...extra }
}

export const FIELDS: readonly FieldMeta[] = [
  f('baseURL', 'text', 'connection', 'text', 'http://127.0.0.1:8080',
    { label: '服务地址', hint: 'llama-server 的根地址', detail: '例如 http://127.0.0.1:8080。末尾的 /v1 会自动去掉；只支持 http:// 与 https://。' },
    { label: 'Service URL', hint: 'Root address of the llama-server', detail: 'e.g. http://127.0.0.1:8080. A trailing /v1 is dropped; http:// and https:// only.' },
    { pattern: URL_PATTERN }),
  f('apiKeyEnv', 'text', 'connection', 'text', 'HUMANIZER_API_KEY',
    { label: '密钥名称', hint: '密钥在 dsh 凭据中的名字', detail: '凭据（环境变量）名。密钥本身保存在 ~/.dsh/.credentials.yaml，不会写进配置文件，也不会发送到浏览器。' },
    { label: 'Key name', hint: 'Name of the key in dsh credentials', detail: 'Credential (env-var) name. The key itself lives in ~/.dsh/.credentials.yaml — never in the config file, never sent to the browser.' },
    { pattern: ENV_PATTERN }),

  f('defaultSamples', 'int', 'common', 'segmented', 1,
    { label: '默认候选数', hint: '每段生成几个版本', detail: '面板的初始候选数，以及智能体调用工具时没有指定 n_samples 的默认值。候选越多越慢。' },
    { label: 'Default candidates', hint: 'Versions written per piece', detail: 'The panel\'s initial count and the tool\'s default when a call gives no n_samples. More is slower.' },
    { min: 1, max: 4 }),
  f('defaultKeep', 'list', 'common', 'chips', [],
    { label: '总是保留的词', hint: '草稿里出现时一字不改', detail: '名字、产品名、口号等。只在草稿中逐字出现时生效；数字和日期无需添加，会自动检查。' },
    { label: 'Always keep', hint: 'Kept word-for-word when present', detail: 'Names, product terms, slogans. Applies only where they appear verbatim; numbers and dates are checked automatically.' }),
  f('toolEnabled', 'bool', 'common', 'switch', true,
    { label: '智能体工具', hint: '让智能体在对话中调用去 AI 味改写' },
    { label: 'Agent tool', hint: 'Let the agent call the rewriter in conversations' }),
  f('promptSection', 'bool', 'common', 'switch', true,
    { label: '系统提示说明', hint: '告诉智能体何时使用该工具' },
    { label: 'System-prompt hint', hint: 'Tell the agent when to use the tool' }),
  f('webUi', 'bool', 'common', 'switch', true,
    { label: '去 AI 味面板', hint: '允许在 dsh web 面板中改写', detail: '关闭后面板无法改写，也无法测试连接；设置仍可在「插件」页修改。' },
    { label: '去AI味 panel', hint: 'Allow rewriting from the dsh web panel', detail: 'When off, the panel can neither rewrite nor test the connection; settings stay editable on the Plugins page.' }),

  f('maxChars', 'int', 'limits', 'number', 20_000,
    { label: '最长草稿', hint: '超过这个字符数的草稿会被拒绝' },
    { label: 'Max draft length', hint: 'Longer drafts are rejected' },
    { min: 1, max: 500_000, unit: { zh: '字符', en: 'chars' } }),
  f('maxWords', 'int', 'limits', 'number', 350,
    { label: '英文每段', hint: '官方 350 词', detail: '正文按句子切段，每段最多这么多英文词。改大会降低质量。' },
    { label: 'English per piece', hint: 'Official 350 words', detail: 'Prose is cut at sentence boundaries into pieces of at most this many words. Larger pieces lower quality.' },
    { min: 20, max: 2000, unit: { zh: '词', en: 'words' } }),
  f('maxCjk', 'int', 'limits', 'number', 600,
    { label: '中文每段', hint: '官方 600 字' },
    { label: 'Chinese per piece', hint: 'Official 600 characters' },
    { min: 20, max: 4000, unit: { zh: '字', en: 'chars' } }),

  f('maxCopy', 'float', 'checks', 'slider', 0.5,
    { label: '照抄率阈值', hint: '和原文重合超过此比例就重写', detail: '改写与原文逐词重合的比例。超过阈值视为照抄并重新采样。官方 0.5。' },
    { label: 'Copy-rate threshold', hint: 'Rewrite again above this overlap', detail: 'Share of the rewrite copied word-for-word from the draft. Above it a sample counts as copied and is redrawn. Official 0.5.' },
    { min: 0, max: 1, step: 0.05 }),
  f('langRetries', 'int', 'checks', 'stepper', 3,
    { label: '语言漂移重采样', hint: '输出换了语言时静默重写的次数', detail: '例如中文草稿写成了英文。官方 3 次。' },
    { label: 'Language-drift resamples', hint: 'Silent redraws when the language drifts', detail: 'e.g. a Chinese draft rewritten in English. Official 3.' },
    { min: 0, max: 5 }),
  f('retries', 'int', 'checks', 'stepper', 1,
    { label: '额外重试', hint: '所有候选都有问题时再写几次' },
    { label: 'Extra retries', hint: 'Extra tries when every candidate has a problem' },
    { min: 0, max: 3 }),
  f('factTries', 'int', 'checks', 'stepper', 3,
    { label: '保留词重试', hint: '保留词在输出中丢失时最多重试几次' },
    { label: 'Keep-term tries', hint: 'Tries when a kept term is lost' },
    { min: 1, max: 5 }),

  f('sampling.temperature', 'float', 'sampling', 'number', 1.0,
    { label: 'temperature', hint: '官方 1.0' }, { label: 'temperature', hint: 'Official 1.0' },
    { min: 0, max: 2, step: 0.05, official: true }),
  f('sampling.top_p', 'float', 'sampling', 'number', 0.95,
    { label: 'top_p', hint: '官方 0.95' }, { label: 'top_p', hint: 'Official 0.95' },
    { min: 0, max: 1, step: 0.01, official: true }),
  f('sampling.top_k', 'int', 'sampling', 'number', 0,
    { label: 'top_k', hint: '官方 0（不限制）' }, { label: 'top_k', hint: 'Official 0 (off)' },
    { min: 0, max: 1000, official: true }),
  f('sampling.min_p', 'float', 'sampling', 'number', 0,
    { label: 'min_p', hint: '官方 0' }, { label: 'min_p', hint: 'Official 0' },
    { min: 0, max: 1, step: 0.01, official: true }),
  f('sampling.repeat_penalty', 'float', 'sampling', 'number', 1.0,
    { label: 'repeat_penalty', hint: '官方 1.0' }, { label: 'repeat_penalty', hint: 'Official 1.0' },
    { min: 0.5, max: 2, step: 0.05, official: true }),
  f('maxPredict', 'int', 'sampling', 'number', 2048,
    { label: 'n_predict 上限', hint: '官方 2048', detail: '每段的 n_predict = 原文 token × 2.5，夹在 256 与这个上限之间。' },
    { label: 'n_predict cap', hint: 'Official 2048', detail: 'Per piece n_predict = draft tokens × 2.5, clamped between 256 and this cap.' },
    { min: 256, max: 8192, official: true }),

  f('requestTimeoutMs', 'int', 'network', 'duration', 600_000,
    { label: '单次请求超时', hint: '等待模型写完一段的最长时间' },
    { label: 'Request timeout', hint: 'Longest wait for one piece' },
    { min: 1000, max: 3_600_000, scale: 1000, unit: SEC }),
  f('busyRetries', 'int', 'network', 'stepper', 3,
    { label: '忙碌/断线重试', hint: '服务忙或连不上时重试几次', detail: '依次等待 3 秒、10 秒、20 秒、30 秒、30 秒后重试。' },
    { label: 'Busy/offline retries', hint: 'Retries when busy or unreachable', detail: 'Waits 3 s, 10 s, 20 s, 30 s, 30 s before each retry.' },
    { min: 0, max: 5 }),
  f('toolTimeoutMs', 'int', 'network', 'duration', 1_800_000,
    { label: '工具调用总时长', hint: '一次工具调用（全部段落）的上限' },
    { label: 'Tool call limit', hint: 'Limit for one tool call (all pieces)' },
    { min: 1000, max: 7_200_000, scale: 60_000, unit: MIN }),

  f('toolName', 'text', 'tool', 'text', 'humanize_text',
    { label: '工具名', hint: '智能体看到的工具名', detail: '字母开头，只含字母、数字、下划线和连字符。修改后从下一轮对话起生效。' },
    { label: 'Tool name', hint: 'Name the agent sees', detail: 'Starts with a letter; letters, digits, _ and -. Applies from the next turn.' },
    { pattern: TOOL_PATTERN }),
]

export const FIELD_BY_KEY: ReadonlyMap<string, FieldMeta> = new Map(FIELDS.map((x) => [x.key, x]))

/** Keys "恢复官方默认" clears. */
export const OFFICIAL_KEYS: readonly string[] = FIELDS.filter((x) => x.official).map((x) => x.key)

/** Settings-form namespace: the profile entry id the bundle patch inserts. */
export const ENTRY_ID = 'tool-humanize'
/** Package name, the bundle key on the Plugins page. */
export const PACKAGE_NAME = 'dsh-tool-humanize'

/** Split a keep-terms text into terms (commas, 、, semicolons or new lines). */
export function splitTerms(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[\n,，、;；]+/)) {
    const t = raw.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** Format a number for display without float noise. */
export function displayNumber(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

/** The valid range in display units, e.g. "1–3600 秒". */
export function rangeText(meta: FieldMeta, lang: 'zh' | 'en' = 'zh'): string {
  if (meta.min === undefined && meta.max === undefined) return ''
  const s = meta.scale ?? 1
  const unit = meta.unit ? ` ${meta.unit[lang]}` : ''
  return `${displayNumber((meta.min ?? 0) / s)}–${displayNumber((meta.max ?? 0) / s)}${unit}`
}

/**
 * Check one stored value against a field (the same rules the host schema enforces).
 * @returns an error message, or undefined when valid.
 */
export function checkValue(meta: FieldMeta, value: unknown, lang: 'zh' | 'en' = 'zh'): string | undefined {
  const zh = lang === 'zh'
  switch (meta.kind) {
    case 'bool': return typeof value === 'boolean' ? undefined : (zh ? '需要开/关' : 'Must be on/off')
    case 'list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) return zh ? '需要词语列表' : 'Must be a list of terms'
      if (value.length > 50) return zh ? '最多 50 个' : 'At most 50'
      return undefined
    case 'text':
      if (typeof value !== 'string' || !value.trim()) return zh ? '不能为空' : 'Required'
      if (meta.pattern && !new RegExp(meta.pattern).test(value)) {
        if (meta.key === 'baseURL') return zh ? '需要以 http:// 或 https:// 开头的地址' : 'Must start with http:// or https://'
        if (meta.key === 'apiKeyEnv') return zh ? '只能包含字母、数字和下划线，且不能以数字开头' : 'Letters, digits and _ only; must not start with a digit'
        return zh ? '格式不对' : 'Invalid format'
      }
      return undefined
    default: {
      const range = rangeText(meta, lang)
      if (typeof value !== 'number' || !Number.isFinite(value)) return zh ? `请输入数字（${range}）` : `Enter a number (${range})`
      if (meta.kind === 'int' && !Number.isInteger(value)) return zh ? `请输入整数（${range}）` : `Enter a whole number (${range})`
      if ((meta.min !== undefined && value < meta.min) || (meta.max !== undefined && value > meta.max)) return zh ? `超出范围：${range}` : `Out of range: ${range}`
      return undefined
    }
  }
}
