/**
 * CSS 类名冲突审查。
 *
 * 起因：顶栏写成 <header class="bar">，同时余额卡片的占比条用了 `.bar { height:7px;
 * overflow:hidden }`。两条规则命中同一个元素，顶栏被压成 7px 高、内容被裁掉。
 *
 * 这里抓两种「裸类名泄漏」：
 *   1. 同一个类既有裸规则 `.foo`，又出现在别的元素上 `tag.foo`
 *   2. 同一个类既有裸规则 `.foo`，又出现在别人的子树里 `.other .foo`
 *
 * @returns {{ problems: Array<{name:string,sel:string,why:string}>, selectorCount:number, classCount:number }}
 */
export function auditCssClasses(html) {
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  const css = (styleMatch ? styleMatch[1] : '').replace(/\/\*[\s\S]*?\*\//g, '');

  const selectors = [];
  const ruleRe = /([^{}]+)\{/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    for (const raw of match[1].split(',')) {
      const sel = raw.trim();
      if (!sel || sel.startsWith('@')) continue;
      // 丢掉伪元素，保留伪类用于识别裸规则
      selectors.push(sel);
    }
  }

  const classRe = /\.([A-Za-z][\w-]*)/g;
  const classNames = new Set();
  for (const sel of selectors) {
    for (const found of sel.matchAll(classRe)) classNames.add(found[1]);
  }

  const problems = [];
  const split = (sel) => sel.split(/\s+|>/).filter(Boolean);

  for (const name of classNames) {
    const dot = `.${name}`;
    const escaped = new RegExp(`\\${dot}(?![\\w-])`);
    const own = selectors.filter((sel) => escaped.test(sel));
    if (!own.length) continue;

    // 裸规则：整条选择器就是这个类（可以带伪类），没有任何标签或别的类限定
    const bareRe = new RegExp(`^\\${dot}(::?[\\w-]+(\\([^)]*\\))?)*$`);
    const bare = own.filter((sel) => bareRe.test(sel.trim()));
    if (!bare.length) continue;

    for (const sel of own) {
      const compounds = split(sel);
      if (compounds.length === 1) {
        // 形如 header.foo：标签 + 这个类，且没有别的类限定 → 裸规则会作用到另一种元素上
        if (bare.includes(sel.trim())) continue;
        const compound = compounds[0];
        const classCount = (compound.match(classRe) || []).length;
        if (classCount === 1 && /^[A-Za-z]/.test(compound)) {
          problems.push({ name, sel, why: `裸规则 .${name} 会连同 ${sel} 一起命中，元素类型不同` });
        }
        continue;
      }
      // 后代选择器：这个类不是最外层，说明裸规则会漏进别的组件子树
      if (compounds[0] !== dot) {
        problems.push({ name, sel, why: `裸规则 .${name} 会漏进 ${compounds[0]} 的子树` });
      }
    }
  }

  return { problems, selectorCount: selectors.length, classCount: classNames.size };
}
