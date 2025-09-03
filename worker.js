// filename: worker.js
// 目标站
const TARGET = "http://www.mx56.vip";

// 只支持这三种语言
const SUPPORTED = new Set(["zh-CN", "en", "es"]);

// LibreTranslate 公共实例（可改为你自己的）
const LT_ENDPOINT = "https://translate.astian.org/translate"; 
// 也可换: https://libretranslate.de/translate  或 你自建实例

// 从请求推断语言（zh / en / es）
function detectLang(req) {
  const url = new URL(req.url);
  let lang = url.searchParams.get("lang") || "";
  if (!lang) {
    const al = (req.headers.get("accept-language") || "").toLowerCase();
    if (al.startsWith("zh")) lang = "zh-CN";
    else if (al.startsWith("es")) lang = "es";
    else lang = "en";
  }
  if (!SUPPORTED.has(lang)) lang = "en";
  return lang;
}

// 简单映射到 LibreTranslate 的目标语言代码
function toLT(lang) {
  if (lang === "zh-CN") return "zh";
  return lang; // en / es
}

// 仅对 text 节点做翻译，避免破坏标签
async function translateText(text, target) {
  const body = {
    q: text,
    source: "auto",
    target,
    format: "text"
  };
  const resp = await fetch(LT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) return text; // 失败就回退原文
  const data = await resp.json().catch(() => ({}));
  return data.translatedText || text;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // 仅处理 /proxy 路径，其它照常返回
    if (url.pathname !== "/proxy") {
      return new Response(
        `Use /proxy to view the site. e.g. ${url.origin}/proxy`,
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // 语言选择：zh-CN / en / es
    const lang = detectLang(req);
    const ltTarget = toLT(lang);

    // 代理获取目标页面
    const upstream = await fetch(TARGET, {
      headers: {
        // 伪装一些头，尽量拿到正常页面
        "user-agent": req.headers.get("user-agent") || "",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,es;q=0.7"
      }
    });

    // 不是 HTML 的资源（js/css/img），直接透传
    const ctype = upstream.headers.get("content-type") || "";
    if (!ctype.includes("text/html")) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": ctype }
      });
    }

    // HTML 流式重写 + 翻译文本节点
    const rewriter = new HTMLRewriter()
      // 修正 <base>，让相对链接能正常加载
      .on("head", {
        element(el) {
          el.append(`<base href="${TARGET}/">`, { html: true });
        }
      })
      // 页内所有文本节点进行翻译（简化：跳过 script/style/noscript）
      .on("*", {
        async text(t) {
          if (t.lastInTextNode && t.text.trim()) {
            // 跳过代码/样式等
            if (["script", "style", "noscript"].includes(t._replacementText?.tagName)) return;
            try {
              const translated = await translateText(t.text, ltTarget);
              t.replace(translated);
            } catch (_) {
              // 出错就保留原文
            }
          }
        }
      });

    return rewriter.transform(upstream);
  }
};
