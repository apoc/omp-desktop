/* model-names.js — Model ID → human display name lookup.
   Fallback: formatModelId() in adapter.js strips provider prefix and title-cases. */
window.MODEL_NAMES = {
  // Anthropic
  "claude-opus-4-5":            "Opus 4.5",
  "claude-opus-4-1":            "Opus 4.1",
  "claude-sonnet-4-7":          "Sonnet 4.7",
  "claude-sonnet-4-5":          "Sonnet 4.5",
  "claude-haiku-4-5":           "Haiku 4.5",
  "claude-3-7-sonnet-20250219": "Sonnet 3.7",
  "claude-3-7-sonnet-latest":   "Sonnet 3.7",
  "claude-3-5-sonnet-20241022": "Sonnet 3.5",
  "claude-3-5-sonnet-latest":   "Sonnet 3.5",
  "claude-3-5-haiku-20241022":  "Haiku 3.5",
  "claude-3-5-haiku-latest":    "Haiku 3.5",
  "claude-3-opus-20240229":     "Opus 3",
  "claude-3-opus-latest":       "Opus 3",
  // OpenAI
  "gpt-4o":                     "GPT-4o",
  "gpt-4o-mini":                "GPT-4o mini",
  "gpt-4-turbo":                "GPT-4 Turbo",
  "o1":                         "o1",
  "o1-mini":                    "o1 mini",
  "o1-preview":                 "o1 preview",
  "o3":                         "o3",
  "o3-mini":                    "o3 mini",
  "o4-mini":                    "o4 mini",
  // Google
  "gemini-2.5-pro-preview":     "Gemini 2.5 Pro",
  "gemini-2.5-pro":             "Gemini 2.5 Pro",
  "gemini-2.0-flash":           "Gemini 2.0 Flash",
  "gemini-2.0-flash-exp":       "Gemini 2.0 Flash",
  "gemini-1.5-pro":             "Gemini 1.5 Pro",
  "gemini-1.5-flash":           "Gemini 1.5 Flash",
  // Qwen / local
  "qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder",
  "qwen3-coder":                "Qwen3 Coder",
  "qwen3-235b-a22b":            "Qwen3 235B",
  // DeepSeek
  "deepseek-chat":              "DeepSeek Chat",
  "deepseek-reasoner":          "DeepSeek R1",
};
