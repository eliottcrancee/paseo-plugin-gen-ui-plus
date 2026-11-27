// Pure, zero-dependency LaTeX -> MathML (web/desktop native rendering inside
// the theme-injecting sandboxed iframe) and LaTeX -> Unicode (mobile / inline
// fallback) converter. Everything is XML-escaped so untrusted specs stay safe.

const SYMBOLS: Readonly<Record<string, string>> = {
  // Lowercase Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  // Uppercase Greek
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Operators & relations
  pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", ast: "∗", star: "⋆",
  circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
  ll: "≪", gg: "≫",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", iff: "⟺",
  mapsto: "↦", uparrow: "↑", downarrow: "↓",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", land: "∧", lor: "∨",
  therefore: "∴", because: "∵",
  // Calculus & constants
  infty: "∞", partial: "∂", nabla: "∇", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  aleph: "ℵ", wp: "℘", angle: "∠", perp: "⊥", parallel: "∥", triangle: "△",
  deg: "°", prime: "′",
  // Big operators
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂",
  // Dots & spaces
  dots: "…", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  quad: "\u2001", qquad: "\u2001\u2001",
  // Escaped delimiters
  "{": "{", "}": "}", "%": "%", "&": "&", "#": "#", "_": "_", "$": "$",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  mid: "|", Vert: "‖", "|": "‖",
};

const UNDEROVER_OPS = new Set(["sum", "prod", "coprod", "bigcup", "bigcap", "bigoplus", "bigotimes", "lim", "limsup", "liminf", "max", "min", "sup", "inf", "argmax", "argmin"]);

const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "limsup", "liminf",
  "max", "min", "sup", "inf", "argmax", "argmin", "det", "dim", "gcd",
  "ker", "hom", "deg", "Pr", "mod", "bmod", "pmod",
]);

const BLACKBOARD: Readonly<Record<string, string>> = {
  C: "ℂ", E: "𝔼", F: "𝔽", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
};

const ACCENTS: Readonly<Record<string, string>> = {
  hat: "^", bar: "¯", overline: "¯", vec: "→", tilde: "˜", dot: "˙", ddot: "¨",
};

const MATRIX_DELIMS: Readonly<Record<string, readonly [string, string]>> = {
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
  matrix: ["", ""],
  smallmatrix: ["", ""],
  cases: ["{", ""],
  aligned: ["", ""],
  align: ["", ""],
  "align*": ["", ""],
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", k: "ₖ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Cursor {
  readonly src: string;
  pos: number;
}

function skipWs(c: Cursor): void {
  while (c.pos < c.src.length && /\s/.test(c.src[c.pos]!)) c.pos++;
}

function readGroupText(c: Cursor): string {
  skipWs(c);
  if (c.pos >= c.src.length) return "";
  if (c.src[c.pos] !== "{") {
    return c.src[c.pos++]!;
  }
  c.pos++; // skip {
  let depth = 1;
  let out = "";
  while (c.pos < c.src.length && depth > 0) {
    const ch = c.src[c.pos++]!;
    if (ch === "\\" && c.pos < c.src.length) {
      out += ch + c.src[c.pos++]!;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
  }
  return out;
}

function readBracketText(c: Cursor): string | null {
  skipWs(c);
  if (c.src[c.pos] !== "[") return null;
  c.pos++;
  let depth = 1;
  let out = "";
  while (c.pos < c.src.length && depth > 0) {
    const ch = c.src[c.pos++]!;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
  }
  return out;
}

function readCommand(c: Cursor): string {
  c.pos++; // skip \
  if (c.pos >= c.src.length) return "";
  const first = c.src[c.pos]!;
  if (!/[A-Za-z]/.test(first)) {
    c.pos++;
    return first;
  }
  let name = "";
  while (c.pos < c.src.length && /[A-Za-z*]/.test(c.src[c.pos]!)) {
    name += c.src[c.pos++]!;
  }
  return name;
}

function readEnvBody(c: Cursor, envName: string): string {
  const endTag = `\\end{${envName}}`;
  const idx = c.src.indexOf(endTag, c.pos);
  if (idx === -1) {
    const rest = c.src.slice(c.pos);
    c.pos = c.src.length;
    return rest;
  }
  const body = c.src.slice(c.pos, idx);
  c.pos = idx + endTag.length;
  return body;
}

interface ParsedAtom {
  readonly ml: string;
  readonly underOver?: boolean;
}

function parseAtom(c: Cursor, display: boolean): ParsedAtom | null {
  skipWs(c);
  if (c.pos >= c.src.length) return null;
  const ch = c.src[c.pos]!;

  if (ch === "{") {
    const inner = readGroupText(c);
    return { ml: `<mrow>${latexToMathMlInner(inner, display)}</mrow>` };
  }

  if (ch === "}") {
    c.pos++;
    return null;
  }

  if (ch === "\\") {
    const cmd = readCommand(c);
    if (cmd === "" || cmd === "," || cmd === ";" || cmd === ":" || cmd === "!" || cmd === " ") {
      const space = cmd === "!" ? "-0.15em" : cmd === "," ? "0.17em" : "0.28em";
      return { ml: `<mspace width="${space}"/>` };
    }
    if (cmd === "\\") {
      return { ml: `<mspace linebreak="newline"/>` };
    }
    if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
      const num = readGroupText(c);
      const den = readGroupText(c);
      return { ml: `<mfrac><mrow>${latexToMathMlInner(num, display)}</mrow><mrow>${latexToMathMlInner(den, display)}</mrow></mfrac>` };
    }
    if (cmd === "sqrt") {
      const idx = readBracketText(c);
      const rad = readGroupText(c);
      if (idx !== null) {
        return { ml: `<mroot><mrow>${latexToMathMlInner(rad, display)}</mrow><mrow>${latexToMathMlInner(idx, display)}</mrow></mroot>` };
      }
      return { ml: `<msqrt>${latexToMathMlInner(rad, display)}</msqrt>` };
    }
    if (cmd === "text" || cmd === "textrm" || cmd === "operatorname") {
      const txt = readGroupText(c);
      return { ml: `<mtext>${escXml(txt)}</mtext>` };
    }
    if (cmd === "mathrm") {
      const txt = readGroupText(c);
      return { ml: `<mi mathvariant="normal">${escXml(txt)}</mi>` };
    }
    if (cmd === "mathbf" || cmd === "boldsymbol" || cmd === "bm") {
      const txt = readGroupText(c);
      return { ml: `<mrow mathvariant="bold">${latexToMathMlInner(txt, display)}</mrow>` };
    }
    if (cmd === "mathbb") {
      const txt = readGroupText(c);
      const mapped = [...txt].map((ch2) => BLACKBOARD[ch2] ?? ch2).join("");
      return { ml: `<mi mathvariant="double-struck">${escXml(mapped)}</mi>` };
    }
    if (cmd === "mathcal") {
      const txt = readGroupText(c);
      return { ml: `<mi mathvariant="script">${escXml(txt)}</mi>` };
    }
    if (Object.hasOwn(ACCENTS, cmd)) {
      const inner = readGroupText(c);
      return { ml: `<mover accent="true"><mrow>${latexToMathMlInner(inner, display)}</mrow><mo>${escXml(ACCENTS[cmd]!)}</mo></mover>` };
    }
    if (cmd === "left" || cmd === "right") {
      skipWs(c);
      if (c.pos >= c.src.length) return { ml: "" };
      let delim = c.src[c.pos]!;
      if (delim === "\\") {
        const dCmd = readCommand(c);
        delim = SYMBOLS[dCmd] ?? dCmd;
      } else {
        c.pos++;
      }
      if (delim === ".") return { ml: "" };
      return { ml: `<mo stretchy="true">${escXml(delim)}</mo>` };
    }
    if (cmd === "begin") {
      const env = readGroupText(c).trim();
      const body = readEnvBody(c, env);
      const rows = body
        .split(/\\\\/)
        .map((r) => r.trim())
        .filter((r) => r !== "")
        .map((row) => {
          const cells = row
            .split("&")
            .map((cell) => `<mtd>${latexToMathMlInner(cell.trim(), display)}</mtd>`)
            .join("");
          return `<mtr>${cells}</mtr>`;
        })
        .join("");
      const table = `<mtable>${rows}</mtable>`;
      const delims = MATRIX_DELIMS[env];
      if (!delims || (delims[0] === "" && delims[1] === "")) {
        return { ml: table };
      }
      const open = delims[0] ? `<mo stretchy="true">${escXml(delims[0])}</mo>` : "";
      const close = delims[1] ? `<mo stretchy="true">${escXml(delims[1])}</mo>` : "";
      return { ml: `<mrow>${open}${table}${close}</mrow>` };
    }
    if (FUNCTIONS.has(cmd)) {
      return { ml: `<mi>${escXml(cmd)}</mi>`, underOver: UNDEROVER_OPS.has(cmd) };
    }
    if (Object.hasOwn(SYMBOLS, cmd)) {
      const sym = SYMBOLS[cmd]!;
      const isOp = !/^[α-ωΑ-Ωℏℓℜℑℵ℘]$/.test(sym);
      return {
        ml: isOp ? `<mo>${escXml(sym)}</mo>` : `<mi>${escXml(sym)}</mi>`,
        underOver: UNDEROVER_OPS.has(cmd),
      };
    }
    return { ml: `<mi>${escXml(cmd)}</mi>` };
  }

  // Numbers
  if (/[0-9]/.test(ch)) {
    let num = "";
    while (c.pos < c.src.length && /[0-9.]/.test(c.src[c.pos]!)) num += c.src[c.pos++]!;
    return { ml: `<mn>${escXml(num)}</mn>` };
  }

  // Identifiers
  if (/[A-Za-z]/.test(ch)) {
    c.pos++;
    return { ml: `<mi>${escXml(ch)}</mi>` };
  }

  // Operators & punctuation
  c.pos++;
  const mappedOp = ch === "-" ? "−" : ch;
  return { ml: `<mo>${escXml(mappedOp)}</mo>` };
}

function latexToMathMlInner(source: string, display: boolean): string {
  const c: Cursor = { src: source, pos: 0 };
  const out: string[] = [];

  while (c.pos < c.src.length) {
    skipWs(c);
    if (c.pos >= c.src.length) break;
    const base = parseAtom(c, display);
    if (base === null) continue;

    let sub: string | null = null;
    let sup: string | null = null;
    for (let k = 0; k < 2; k++) {
      skipWs(c);
      if (c.src[c.pos] === "_" && sub === null) {
        c.pos++;
        const atom = parseAtom(c, false);
        sub = atom ? atom.ml : "<mrow/>";
      } else if (c.src[c.pos] === "^" && sup === null) {
        c.pos++;
        const atom = parseAtom(c, false);
        sup = atom ? atom.ml : "<mrow/>";
      } else {
        break;
      }
    }

    const useUnderOver = display && base.underOver;
    if (sub !== null && sup !== null) {
      out.push(useUnderOver ? `<munderover>${base.ml}${sub}${sup}</munderover>` : `<msubsup>${base.ml}${sub}${sup}</msubsup>`);
    } else if (sub !== null) {
      out.push(useUnderOver ? `<munder>${base.ml}${sub}</munder>` : `<msub>${base.ml}${sub}</msub>`);
    } else if (sup !== null) {
      out.push(useUnderOver ? `<mover>${base.ml}${sup}</mover>` : `<msup>${base.ml}${sup}</msup>`);
    } else {
      out.push(base.ml);
    }
  }

  return out.join("");
}

/** Converts LaTeX math into a complete native `<math>` MathML element. */
export function latexToMathMl(latex: string, display = true): string {
  const inner = latexToMathMlInner(latex.trim(), display);
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? "block" : "inline"}"><mrow>${inner}</mrow></math>`;
}

const MATH_CSS = `.g-math{padding:8px 10px;overflow-x:auto;color:var(--foreground);text-align:center}
.g-math.inline{padding:2px 4px;text-align:left}
.g-math math{font-size:1.15em;line-height:1.5;color:var(--foreground)}`;

/** Builds the sandboxed HTML snippet for a `Math` block on web/desktop. */
export function buildMathHtml(latex: string, display = true): string {
  return `<div class="g-math${display ? "" : " inline"}"><style>${MATH_CSS}</style>${latexToMathMl(latex, display)}</div>`;
}

/** Lightweight Unicode math fallback for mobile / inline spans. */
export function latexToUnicode(latex: string): string {
  let out = latex.trim();
  // Replace \frac{a}{b} -> (a)/(b)
  out = out.replace(/\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  out = out.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  out = out.replace(/\\(?:text|textrm|mathrm|mathbf)\{([^{}]*)\}/g, "$1");
  out = out.replace(/\\mathbb\{([A-Za-z]+)\}/g, (_, chars: string) =>
    [...chars].map((ch) => BLACKBOARD[ch] ?? ch).join(""),
  );
  out = out.replace(/\\(?:left|right)([()[\]|.]|\\[{}])/g, (_, d: string) => (d === "." ? "" : d.replace(/^\\/, "")));
  out = out.replace(/\\([A-Za-z]+)/g, (full, cmd: string) => {
    if (Object.hasOwn(SYMBOLS, cmd)) return SYMBOLS[cmd]!;
    if (FUNCTIONS.has(cmd)) return cmd;
    return full;
  });
  out = out.replace(/\^\{([^{}]+)\}|\^([0-9+\-=()ni])/g, (full, g1?: string, g2?: string) => {
    const raw = g1 ?? g2 ?? "";
    const mapped = [...raw].map((ch) => SUPERSCRIPTS[ch]).join("");
    return mapped.length === raw.length ? mapped : full;
  });
  out = out.replace(/_\{([^{}]+)\}|_([0-9+\-=()aeijkmnoprstuvx])/g, (full, g1?: string, g2?: string) => {
    const raw = g1 ?? g2 ?? "";
    const mapped = [...raw].map((ch) => SUBSCRIPTS[ch]).join("");
    return mapped.length === raw.length ? mapped : full;
  });
  return out.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
