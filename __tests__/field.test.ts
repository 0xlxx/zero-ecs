// packages/ecs/__tests__/field.test.ts — field descriptor system
// Single source of truth: validation + encoding + docs from one definition.

import { describe, it, expect } from "vitest";
import { f, parseFields, fieldCatalog, defaultsFromFields, hasBindableFields } from "../src/field.js";
import { defineComponent, fieldMeta } from "../src/component.js";

// ═══════════════════════════════════════════════════════════
// defineComponent field mode
// ═══════════════════════════════════════════════════════════

const Curve = defineComponent("curve", {
  expr: f.str().doc("数学表达式，如 a*sin(x)").required(),
  domain: f.tuple(f.num(), f.num()).default([-10, 10]),
  params: f.map(f.num()).doc("自由变量 → DataStore 路径").default({}),
  samples: f.int().default(200).min(8).max(2000),
  color: f.hex().default(0x1a1a1a),
  width: f.num().default(2),
});

const Point = defineComponent("point", {
  at: f.vec3().default([0, 0, 0]).bindable(),
  color: f.hex().default(0xe06b38),
  radius: f.num().default(0.06),
});

describe("defineComponent field mode", () => {
  it("registers field metadata for the kind", () => {
    const meta = fieldMeta("curve");
    expect(meta).toBeDefined();
    expect(Object.keys(meta!)).toEqual(["expr", "domain", "params", "samples", "color", "width"]);
    expect(meta!.expr.kind).toBe("str");
  });

  it("raw-mode components have no field meta", () => {
    const Raw = defineComponent("rawComp", { x: 1 });
    expect(fieldMeta("rawComp")).toBeUndefined();
    expect(Raw({ x: 5 }).x).toBe(5);
  });

  it("factory merges defaults from descriptors", () => {
    const c = Curve({ expr: "sin(x)" });
    expect(c.expr).toBe("sin(x)");
    expect(c.domain).toEqual([-10, 10]);
    expect(c.samples).toBe(200);
    expect(c.color).toBe(0x1a1a1a);
    expect(c.type).toBe("curve");
  });
});

// ═══════════════════════════════════════════════════════════
// parseFields — JSON protocol values → internal values
// ═══════════════════════════════════════════════════════════

describe("parseFields", () => {
  const fields = {
    expr: f.str().required(),
    domain: f.tuple(f.num(), f.num()).default([-10, 10]),
    samples: f.int().default(200).min(8).max(2000),
    color: f.hex().default(0x1a1a1a),
    at: f.vec3().default([0, 0, 0]).bindable(),
    params: f.map(f.num()).default({}),
  };

  it("parses literals and converts hex strings", () => {
    const r = parseFields(fields, { expr: "a*sin(x)", color: "#ff4444" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.expr).toBe("a*sin(x)");
      expect(r.value.color).toBe(0xff4444);
      expect(r.value.samples).toBe(200); // default filled
      expect(r.value.domain).toEqual([-10, 10]);
      expect(r.value.params).toEqual({});
    }
  });

  it("validates required fields", () => {
    const r = parseFields(fields, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe("expr");
      expect(r.errors[0].hint).toBeDefined();
    }
  });

  it("rejects unknown fields with hint", () => {
    const r = parseFields(fields, { expr: "x", bogus: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path === "bogus")).toBe(true);
  });

  it("rejects out-of-range numbers", () => {
    const r = parseFields(fields, { expr: "x", samples: 99999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("samples");
  });

  it("rejects non-integer for int fields", () => {
    const r = parseFields(fields, { expr: "x", samples: 12.5 });
    expect(r.ok).toBe(false);
  });

  it("passes bind values through only for bindable fields", () => {
    const ok = parseFields(fields, { expr: "x", at: { path: "/p" } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.at).toEqual({ path: "/p" });

    const bad = parseFields(fields, { expr: { path: "/e" } });
    expect(bad.ok).toBe(false); // expr not bindable
  });

  it("validates vec3 shape", () => {
    const r = parseFields(fields, { expr: "x", at: [1, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("at");
  });

  it("validates tuple length", () => {
    const r = parseFields(fields, { expr: "x", domain: [1, 2, 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("domain");
  });

  it("validates array and map elements recursively", () => {
    const fs = {
      tags: f.array(f.str()).default([]),
      params: f.map(f.num()).default({}),
    };
    const ok = parseFields(fs, { tags: ["a", "b"], params: { k: 1 } });
    expect(ok.ok).toBe(true);

    const bad1 = parseFields(fs, { tags: ["a", 2] });
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.errors[0].path).toBe("tags[1]");

    const bad2 = parseFields(fs, { params: { k: "x" } });
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.errors[0].path).toBe("params.k");
  });
});

// ═══════════════════════════════════════════════════════════
// Catalog + helpers
// ═══════════════════════════════════════════════════════════

describe("fieldCatalog", () => {
  it("generates LLM-facing docs from descriptors", () => {
    const cat = fieldCatalog({
      expr: f.str().doc("数学表达式").required(),
      color: f.hex().default(0x1a1a1a),
      at: f.vec3().bindable(),
    });
    expect(cat.expr).toEqual({ type: "str", doc: "数学表达式", required: true, bindable: false, default: undefined });
    expect(cat.color.default).toBe(0x1a1a1a);
    expect(cat.at.bindable).toBe(true);
  });
});

describe("defaultsFromFields / hasBindableFields", () => {
  it("extracts defaults only", () => {
    const d = defaultsFromFields({ expr: f.str().required(), color: f.hex().default(3) });
    expect(d).toEqual({ color: 3 });
  });

  it("detects bindable fields", () => {
    expect(hasBindableFields({ at: f.vec3().bindable() })).toBe(true);
    expect(hasBindableFields({ at: f.vec3() })).toBe(false);
  });
});

describe("Point component end-to-end", () => {
  it("factory + parse + catalog agree", () => {
    const inst = Point({});
    const parsed = parseFields({
      at: f.vec3().default([0, 0, 0]).bindable(),
      color: f.hex().default(0xe06b38),
      radius: f.num().default(0.06),
    }, {});
    expect(inst.at).toEqual([0, 0, 0]);
    if (parsed.ok) expect(parsed.value.at).toEqual([0, 0, 0]);
    expect(inst.color).toBe(0xe06b38);
  });
});
