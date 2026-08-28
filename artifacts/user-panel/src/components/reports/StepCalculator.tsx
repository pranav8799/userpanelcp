import React, { useMemo, useState } from "react";
import { ArrowRight, Link2 } from "lucide-react";

const fmtRound = (n: number): string => {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n / 10) * 10;
  return rounded.toLocaleString("en-IN");
};

const fmtPrecise = (n: number): string => {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 1000) / 1000;
  return rounded.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};

const fmtPct = (n: number): string => {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

interface NumFieldProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  suffix?: string;
  placeholder?: string;
}

function NumField({ label, value, onChange, readOnly, suffix, placeholder }: NumFieldProps) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <div
        className={
          "flex items-center rounded-lg border px-2.5 py-1.5 transition-colors " +
          (readOnly
            ? "border-indigo-100 bg-indigo-50/60"
            : "border-slate-200 bg-white focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100")
        }
      >
        <input
          type={readOnly ? "text" : "number"}
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange && onChange(e.target.value)}
          className={
            "w-full bg-transparent font-mono text-[15px] text-slate-800 outline-none placeholder:text-slate-300 " +
            (readOnly ? "cursor-default text-indigo-700" : "")
          }
        />
        {suffix && <span className="ml-1 shrink-0 text-xs text-slate-400">{suffix}</span>}
      </div>
    </label>
  );
}

interface ResultRowProps {
  label: string;
  value: number;
  emphasis?: boolean;
  suffix?: string;
}

function ResultRow({ label, value, emphasis, suffix }: ResultRowProps) {
  return (
    <div
      className={
        "flex items-baseline justify-between border-t border-dashed border-slate-200 pt-1 first:border-t-0 first:pt-0 " +
        (emphasis ? "-mx-1 mt-1 rounded-lg border-t-0 bg-indigo-50 px-2 py-1.5" : "")
      }
    >
      <span className="text-xs text-slate-400">{label}</span>
      <span
        className={
          "font-mono tabular-nums " +
          (emphasis ? "text-lg font-semibold text-indigo-700" : "text-sm text-slate-600")
        }
      >
        {suffix === "%" ? fmtPct(value) : fmtRound(value)}
        {suffix ? <span className="ml-0.5 text-xs text-slate-400">{suffix}</span> : null}
      </span>
    </div>
  );
}

interface ChainTableAIProps {
  a: string; setA: (v: string) => void;
  b: string; setB: (v: string) => void;
  c: number;
  d: string; setD: (v: string) => void;
  e: number;
  f: string; setF: (v: string) => void;
  g: number; h: number; i: number;
}

function ChainTableAI({ a, setA, b, setB, c, d, setD, e, f, setF, g, h, i }: ChainTableAIProps) {
  const editableCell = (value: string, setValue: (v: string) => void) => (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="w-24 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right font-mono text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
    />
  );
  const computedCell = (value: number, highlight?: boolean, suffix?: string | null, precise?: boolean) => (
    <span
      className={
        "font-mono tabular-nums " +
        (highlight ? "text-base font-semibold text-indigo-700" : "text-slate-600")
      }
    >
      {suffix === "%" ? fmtPct(value) : precise ? fmtPrecise(value) : fmtRound(value)}
      {suffix ? <span className="ml-0.5 text-xs text-slate-400">{suffix}</span> : null}
    </span>
  );
  const cols = [
    { key: "A", label: "A", content: editableCell(a, setA) },
    { key: "B", label: "B", content: editableCell(b, setB) },
    { key: "C", label: "C (A×B)", content: computedCell(c) },
    { key: "D", label: "D", content: editableCell(d, setD) },
    { key: "E", label: "E (C÷D÷99)", content: computedCell(e, false, null, true) },
    { key: "F", label: "F", content: editableCell(f, setF) },
    { key: "G", label: "G (D+F)", content: computedCell(g) },
    { key: "H", label: "H (E×F×99)", content: computedCell(h) },
    { key: "I", label: "I (H vs A %)", content: computedCell(i, true, "%") },
  ];
  return (
    <div className="mt-1 w-full overflow-hidden rounded-lg border border-slate-200">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead className="bg-slate-100">
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-indigo-50/40">
              {cols.map((c) => (
                <td key={c.key} className="px-3 py-2 text-right">
                  {c.content}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface MergedRow {
  count: number;
  subtract: number;
  add: number;
  step1: number;
  step2: number;
  final: number;
  percent: number;
}

interface MergedTableProps {
  rows: MergedRow[];
  avgSubtract: number;
  totalCalc5: number;
  totalStep2: number;
  result5: number;
  calc5Override: string;
  setCalc5Override: (v: string) => void;
  mult7: string;
  setMult7: (v: string) => void;
  fixed7: string;
  setFixed7: (v: string) => void;
}

function MergedTable({
  rows,
  avgSubtract,
  totalCalc5,
  totalStep2,
  result5,
  calc5Override,
  setCalc5Override,
  mult7,
  setMult7,
  fixed7,
  setFixed7,
}: MergedTableProps) {
  const cols = [
    { key: "count", label: "Count", align: "left" },
    { key: "subtract", label: "Subtract", align: "right" },
    { key: "add", label: "Add", align: "right" },
    { key: "calc5", label: "Calc 5 result", align: "right" },
    { key: "mult", label: "Multiplier", align: "right" },
    { key: "fixed", label: "Fixed value", align: "right" },
    { key: "step1", label: "Step 1 (×mult)", align: "right" },
    { key: "step2", label: "Step 2 (÷÷)", align: "right" },
    { key: "final", label: "Final", align: "right" },
    { key: "percent", label: "Final vs #5 %", align: "right" },
  ];
  return (
    <div className="mt-1 w-full overflow-hidden rounded-lg border border-slate-200">
      <div className="max-h-80 overflow-auto">
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100">
            <tr>
              {cols.map((c, i) => (
                <th
                  key={c.key}
                  className={
                    "whitespace-nowrap border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 " +
                    (c.align === "right" ? "text-right" : "text-left") +
                    (i === 0 ? " sticky left-0 z-20 bg-slate-100" : "")
                  }
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const isLast = idx === rows.length - 1;
              const rowBg = isLast ? "bg-indigo-50/70" : idx % 2 === 0 ? "bg-white" : "bg-slate-50/70";
              return (
                <tr key={r.count} className={rowBg}>
                  <td className={"sticky left-0 z-10 border-b border-slate-100 px-3 py-1.5 font-mono text-slate-400 " + rowBg}>
                    {r.count}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums text-slate-600">
                    {fmtRound(r.subtract)}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums text-slate-600">
                    {fmtRound(r.add)}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    {idx === 0 ? (
                      <input
                        type="number"
                        inputMode="decimal"
                        value={calc5Override}
                        onChange={(e) => setCalc5Override(e.target.value)}
                        placeholder={fmtRound(result5)}
                        className="w-24 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right font-mono text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-slate-400">
                        {calc5Override.trim() !== "" ? calc5Override : fmtRound(result5)}
                      </span>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    {idx === 0 ? (
                      <input
                        type="number"
                        inputMode="decimal"
                        value={mult7}
                        onChange={(e) => setMult7(e.target.value)}
                        className="w-20 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right font-mono text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-slate-400">{mult7}</span>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    {idx === 0 ? (
                      <input
                        type="number"
                        inputMode="decimal"
                        value={fixed7}
                        onChange={(e) => setFixed7(e.target.value)}
                        className="w-20 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right font-mono text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-slate-400">{fixed7}</span>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums text-slate-600">
                    {fmtRound(r.step1)}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums text-slate-600">
                    {fmtPrecise(r.step2)}
                  </td>
                  <td
                    className={
                      "border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums " +
                      (isLast ? "font-semibold text-indigo-700" : "text-slate-600")
                    }
                  >
                    {fmtRound(r.final)}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right font-mono tabular-nums text-slate-600">
                    {fmtPct(r.percent)}%
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-3 py-4 text-center text-slate-400">
                  No rounds yet — Calculator 4's result must be at least 1.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-amber-100/80">
                <td className="sticky left-0 z-10 border-t-2 border-amber-300 bg-amber-100/80 px-3 py-2 font-mono font-semibold text-amber-800">
                  Avg / Total
                </td>
                <td className="border-t-2 border-amber-300 px-3 py-2 text-right font-mono tabular-nums font-semibold text-amber-800">
                  {fmtRound(avgSubtract)}
                </td>
                <td className="border-t-2 border-amber-300 px-3 py-2" />
                <td className="border-t-2 border-amber-300 px-3 py-2 text-right font-mono tabular-nums font-semibold text-amber-800">
                  {fmtRound(totalCalc5)}
                </td>
                <td className="border-t-2 border-amber-300 px-3 py-2" />
                <td className="border-t-2 border-amber-300 px-3 py-2" />
                <td className="border-t-2 border-amber-300 px-3 py-2" />
                <td className="border-t-2 border-amber-300 px-3 py-2 text-right font-mono tabular-nums font-semibold text-amber-800">
                  {fmtPrecise(totalStep2)}
                </td>
                <td className="border-t-2 border-amber-300 px-3 py-2" />
                <td className="border-t-2 border-amber-300 px-3 py-2" />
              </tr>
              <tr className="bg-amber-50/60">
                <td className="sticky left-0 z-10 px-3 py-1 bg-amber-50/60" />
                <td className="px-3 py-1 text-right text-[10px] text-amber-700">Avg (Subtract)</td>
                <td className="px-3 py-1" />
                <td className="px-3 py-1 text-right text-[10px] text-amber-700">Total (Calc 5 result)</td>
                <td className="px-3 py-1" />
                <td className="px-3 py-1" />
                <td className="px-3 py-1" />
                <td className="px-3 py-1 text-right text-[10px] text-amber-700">Total (Step 2)</td>
                <td className="px-3 py-1" />
                <td className="px-3 py-1" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

interface CardProps {
  step: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  linkedFrom?: number;
  wide?: boolean;
}

function Card({ step, title, subtitle, children, linkedFrom, wide }: CardProps) {
  return (
    <div
      className={
        "relative flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-sm " +
        (wide ? "sm:col-span-2" : "")
      }
    >
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 font-mono text-[11px] font-bold text-white">
              {step}
            </span>
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          </div>
          {subtitle && <p className="mt-0.5 text-xs leading-snug text-slate-400">{subtitle}</p>}
        </div>
        {linkedFrom && (
          <span className="flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-[10px] font-medium text-indigo-600">
            <Link2 size={11} /> from #{linkedFrom}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

export default function StepCalculator() {
  const [a1, setA1] = useState("5600");
  const [b1, setB1] = useState("4200");

  const [a2, setA2] = useState("5600");
  const [p2, setP2] = useState("30");

  const [c3, setC3] = useState("4200");

  const [d4, setD4] = useState("20");

  const [e5, setE5] = useState("50000");

  const [v6, setV6] = useState("4400");
  const [sub6, setSub6] = useState("20");
  const [add6, setAdd6] = useState("40");

  const [mult7, setMult7] = useState("10");
  const [fixed7, setFixed7] = useState("99");
  const [calc5Override, setCalc5Override] = useState("");

  const [a8, setA8] = useState("100");
  const [b8, setB8] = useState("5");
  const [d8, setD8] = useState("10");
  const [f8, setF8] = useState("2");

  const n = (v: string): number => {
    const x = parseFloat(v);
    return Number.isNaN(x) ? NaN : x;
  };

  const diff1 = useMemo(() => n(a1) - n(b1), [a1, b1]);
  const percent1 = useMemo(() => (diff1 / n(a1)) * 100, [diff1, a1]);

  const cut2 = useMemo(() => (n(a2) * n(p2)) / 100, [a2, p2]);
  const result2 = useMemo(() => n(a2) - cut2, [a2, cut2]);

  const result3 = useMemo(() => n(c3) - result2, [c3, result2]);

  const result4 = useMemo(() => result3 / n(d4), [result3, d4]);

  const result5 = useMemo(() => n(e5) / result4, [e5, result4]);

  const repeatN = useMemo(() => {
    const r = Math.round(result4);
    return Number.isFinite(r) && r >= 0 ? r : 0;
  }, [result4]);

  const rowCount = Math.min(repeatN, 2000);

  const calc5Used = useMemo(
    () => (calc5Override.trim() !== "" ? n(calc5Override) : result5),
    [calc5Override, result5]
  );

  const firstSubtractValue = useMemo(() => n(v6) - n(sub6), [v6, sub6]);
  const fixedStep1 = useMemo(() => calc5Used * n(mult7), [calc5Used, mult7]);
  const fixedStep2 = useMemo(
    () => fixedStep1 / firstSubtractValue / n(fixed7),
    [fixedStep1, firstSubtractValue, fixed7]
  );
  const fixedFinal = useMemo(() => fixedStep2 * n(add6) * n(fixed7), [fixedStep2, add6, fixed7]);

  const finalVsCalc5Percent = useMemo(() => (fixedFinal / calc5Used) * 100, [fixedFinal, calc5Used]);

  const mergedRows: MergedRow[] = useMemo(() => {
    const start = n(v6);
    const subStep = n(sub6);
    const addStep = n(add6);
    const rows: MergedRow[] = [];
    for (let i = 1; i <= rowCount; i++) {
      const subtract = start - subStep * (i - 1);
      const add = subtract + addStep;
      rows.push({
        count: i,
        subtract,
        add,
        step1: fixedStep1,
        step2: fixedStep2,
        final: fixedFinal,
        percent: finalVsCalc5Percent,
      });
    }
    return rows;
  }, [v6, sub6, add6, rowCount, fixedStep1, fixedStep2, fixedFinal, finalVsCalc5Percent]);

  const avgSubtract = useMemo(() => {
    if (mergedRows.length === 0) return NaN;
    const sum = mergedRows.reduce((acc, r) => acc + r.subtract, 0);
    return sum / mergedRows.length;
  }, [mergedRows]);

  const totalCalc5 = useMemo(() => calc5Used * mergedRows.length, [calc5Used, mergedRows.length]);
  const totalStep2 = useMemo(() => fixedStep2 * mergedRows.length, [fixedStep2, mergedRows.length]);

  const c8 = useMemo(() => n(a8) * n(b8), [a8, b8]);
  const e8 = useMemo(() => c8 / n(d8) / 99, [c8, d8]);
  const g8 = useMemo(() => n(d8) + n(f8), [d8, f8]);
  const h8 = useMemo(() => e8 * n(f8) * 99, [e8, f8]);
  const i8 = useMemo(() => (h8 / n(a8)) * 100, [h8, a8]);

  return (
    <div className="w-full">
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-widest text-indigo-500">5-step chain</p>
        <h1 className="text-2xl font-bold text-slate-900">Chain Calculator</h1>
        <p className="mt-1 text-sm text-slate-500">
          Each step feeds the next — cards marked{" "}
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 align-middle">
            <Link2 size={10} /> from #
          </span>{" "}
          pull their value automatically from the step before.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card step={1} title="Difference & %" subtitle="A − B, then diff ÷ A × 100">
          <NumField label="Value A" value={a1} onChange={setA1} />
          <NumField label="Value B" value={b1} onChange={setB1} />
          <div className="mt-0.5 space-y-1 rounded-lg bg-slate-50 p-2">
            <ResultRow label="Difference (A − B)" value={diff1} />
            <ResultRow label="Percent" value={percent1} suffix="%" emphasis />
          </div>
        </Card>

        <Card step={2} title="Cut by %" subtitle="A × P% = cut, then A − cut">
          <NumField label="Value A" value={a2} onChange={setA2} />
          <NumField label="Percent" value={p2} onChange={setP2} suffix="%" />
          <div className="mt-0.5 space-y-1 rounded-lg bg-slate-50 p-2">
            <ResultRow label="Cut amount" value={cut2} />
            <ResultRow label="Result (A − cut)" value={result2} emphasis />
          </div>
        </Card>

        <Card step={3} title="Subtract chained result" subtitle="C − Calculator 2 result" linkedFrom={2}>
          <NumField label="Value C" value={c3} onChange={setC3} />
          <NumField label="Calculator 2 result" value={fmtRound(result2)} readOnly />
          <div className="mt-0.5 space-y-1 rounded-lg bg-slate-50 p-2">
            <ResultRow label="Result (C − #2)" value={result3} emphasis />
          </div>
        </Card>

        <Card step={4} title="Divide chained result" subtitle="Calculator 3 result ÷ divisor" linkedFrom={3}>
          <NumField label="Calculator 3 result" value={fmtRound(result3)} readOnly />
          <NumField label="Divide by" value={d4} onChange={setD4} />
          <div className="mt-0.5 space-y-1 rounded-lg bg-slate-50 p-2">
            <ResultRow label="Result (#3 ÷ divisor)" value={result4} emphasis />
          </div>
        </Card>

        <Card step={5} title="Divide by chained result" subtitle="Value E ÷ Calculator 4 result" linkedFrom={4}>
          <NumField label="Value E" value={e5} onChange={setE5} />
          <NumField label="Calculator 4 result" value={fmtRound(result4)} readOnly />
          <div className="mt-0.5 space-y-1 rounded-lg bg-slate-50 p-2">
            <ResultRow label="Result (E ÷ #4)" value={result5} emphasis />
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Card
          step={6}
          title="Repeat chain (Excel-style)"
          subtitle={`Subtract & Add run ${repeatN}× (from Calculator 4); Step 1/2/Final are fixed, computed once from Calculator 5's result`}
          linkedFrom={5}
        >
          <div className="flex flex-wrap gap-3">
            <div className="w-32">
              <NumField label="Start value" value={v6} onChange={setV6} />
            </div>
            <div className="w-32">
              <NumField label="Subtract by" value={sub6} onChange={setSub6} />
            </div>
            <div className="w-32">
              <NumField label="Add by" value={add6} onChange={setAdd6} />
            </div>
          </div>

          <p className="mt-1 font-mono text-[11px] leading-snug text-slate-400">
            Subtract = Start − (Subtract by × Count) · Add = Start + (Add by × Count) · Step 1 = Calc 5 result ×
            Multiplier (fixed) · Step 2 = Step 1 ÷ first subtract value ÷ Fixed value (fixed) · Final = Step 2 × Add
            by × Fixed value (fixed) · Final vs #5 % = (Final ÷ Calc 5 result) × 100 — Calc 5 result is auto-linked
            from Calculator 5 but editable in the table (leave blank to stay auto-linked)
          </p>

          <MergedTable
            rows={mergedRows}
            avgSubtract={avgSubtract}
            totalCalc5={totalCalc5}
            totalStep2={totalStep2}
            result5={result5}
            calc5Override={calc5Override}
            setCalc5Override={setCalc5Override}
            mult7={mult7}
            setMult7={setMult7}
            fixed7={fixed7}
            setFixed7={setFixed7}
          />

          <div className="mt-0.5 flex items-center justify-between rounded-lg bg-slate-50 p-2.5">
            <span className="text-xs text-slate-400">Final answer (same every row)</span>
            <span className="font-mono text-xl font-semibold tabular-nums text-slate-900">
              {fmtRound(fixedFinal)}
            </span>
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Card step={7} title="Custom chain (A → I)" subtitle="A, B, D, F are manual inputs · C, E, G, H, I are calculated">
          <p className="font-mono text-[11px] leading-snug text-slate-400">
            C = A × B · E = C ÷ D ÷ 99 · G = D + F · H = E × F × 99 · I = (H ÷ A) × 100
          </p>
          <ChainTableAI a={a8} setA={setA8} b={b8} setB={setB8} c={c8} d={d8} setD={setD8} e={e8} f={f8} setF={setF8} g={g8} h={h8} i={i8} />
          <div className="mt-0.5 flex items-center justify-between rounded-lg bg-slate-50 p-2.5">
            <span className="text-xs text-slate-400">I — percentage of A and H</span>
            <span className="font-mono text-xl font-semibold tabular-nums text-slate-900">{fmtPct(i8)}%</span>
          </div>
        </Card>
      </div>

      <div className="mt-4 flex items-center justify-center gap-1 text-xs text-slate-400">
        <ArrowRight size={12} />
        Steps 3 → 4 → 5 → 6 → 7 auto-update whenever an earlier step changes.
      </div>
    </div>
  );
}