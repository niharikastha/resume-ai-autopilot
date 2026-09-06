'use client';

import { Table2, BarChart3 } from 'lucide-react';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  CardHeader,
  EmptyState,
  Table,
  Td,
  Th,
  Tr,
  useReducedMotion,
} from './ui';
import { num } from '@/lib/utils';
import type { FunnelStage } from '@/lib/api';

/** The five ordinal teal steps, read from CSS so light/dark swap for free. */
const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

const AXIS_TICK = { fill: 'var(--ink-muted)', fontSize: 11 };

/** A translucent wash rather than a solid fill: the cursor sits UNDER the bar, so
 *  an opaque colour would swap the plot background out from behind it. */
const CURSOR_FILL = 'color-mix(in srgb, var(--ink-muted) 12%, transparent)';

/**
 * Bars grow from the axis on first paint, unless the OS says not to.
 *
 * The CSS reduced-motion block cannot reach this: recharts animates by
 * interpolating SVG attributes in JavaScript, so there is no CSS animation for
 * `animation-duration: 0.01ms !important` to shorten. The query has to be read
 * here and the animation switched off at the prop.
 */
function useChartMotion(): { active: boolean; duration: number } {
  const reduced = useReducedMotion();
  return { active: !reduced, duration: reduced ? 0 : 650 };
}

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean;
  payload?: { value?: number; payload?: { phase?: string } }[];
  label?: string | number;
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-[0_12px_32px_-12px_rgb(0_0_0/0.6)]">
      <div className="font-medium text-[var(--ink-primary)]">{label}</div>
      <div className="figure mt-1 text-[13px] text-[var(--ink-primary)]">
        {num(point.value)}{' '}
        <span className="font-sans text-xs text-[var(--ink-muted)]">
          {suffix ?? ''}
        </span>
      </div>
      {point.payload?.phase && (
        <div className="mt-0.5 text-[var(--ink-muted)]">
          {point.payload.phase}
        </div>
      )}
    </div>
  );
}

/** Toggle between the plot and its table twin. Identity is never colour-only,
 *  and a screen reader gets real numbers rather than an SVG. */
function ViewToggle({
  view,
  onChange,
}: {
  view: 'chart' | 'table';
  onChange: (v: 'chart' | 'table') => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface)] p-0.5">
      {(
        [
          ['chart', BarChart3, 'Chart view'],
          ['table', Table2, 'Table view'],
        ] as const
      ).map(([value, Icon, title]) => (
        <button
          key={value}
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={
            view === value
              ? 'rounded-[6px] bg-[var(--surface-hover)] px-2 py-1 text-[var(--accent)] shadow-[0_1px_2px_rgb(0_0_0/0.3)]'
              : 'rounded-[6px] px-2 py-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-secondary)]'
          }
        >
          <Icon size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/**
 * Draws every value label, INCLUDING the zero ones.
 *
 * recharts' built-in label skips a bar of zero width, so "Tailored" and
 * "Prepared" rendered as a bare axis label with nothing beside it - which reads
 * as a row that failed to load rather than a stage that is genuinely empty.
 * Anchoring the text at x+width means a zero bar labels at the axis origin, and
 * naming the phase says WHY it is zero.
 *
 * Declared at module scope, not inside FunnelChart. A component defined during
 * render is a NEW component type on every render, so React unmounts the old tree
 * and mounts a fresh one instead of updating it - which throws away any state and
 * costs a full remount per keystroke on the filters. `stages` therefore arrives
 * as a prop; recharts clones this element with each shape's geometry merged in,
 * so the prop survives.
 */
function FunnelValueLabel(props: {
  stages?: FunnelStage[];
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  value?: string | number;
  index?: number;
}) {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0);
  const height = Number(props.height ?? 0);
  const value = Number(props.value ?? 0);
  const stage = props.stages?.[props.index ?? 0];
  return (
    <text
      x={x + width + 6}
      y={y + height / 2}
      dy={4}
      fontSize={11}
      fill={value ? 'var(--ink-secondary)' : 'var(--ink-muted)'}
    >
      {value ? num(value) : `0 · ${stage?.phase ?? 'not yet built'}`}
    </text>
  );
}

/**
 * The discovery funnel as a horizontal bar chart, NOT a tapering funnel shape.
 *
 * A drawn funnel encodes magnitude as an area whose width is not proportional to
 * the value, so a 4,765 -> 137 collapse looks like a gentle taper. Bars on one
 * shared axis keep the two-orders-of-magnitude drop visible, which is the single
 * most important fact this dashboard has to communicate.
 *
 * Colour is an ORDINAL ramp (light -> dark) because the stages are ordered
 * stages of one quantity, not separate categories.
 */
export function FunnelChart({
  stages,
  title,
  subtitle,
}: {
  stages: FunnelStage[];
  title: string;
  subtitle?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const motion = useChartMotion();
  const first = stages[0]?.count ?? 0;

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={<ViewToggle view={view} onChange={setView} />}
      />
      {stages.every((s) => s.count === 0) ? (
        <EmptyState
          title="Nothing has been discovered yet"
          detail="Run discovery, or seed the spike snapshot with npm run db:seed."
          phase="phase 1"
        />
      ) : view === 'chart' ? (
        <div className="px-2 py-4">
          <ResponsiveContainer width="100%" height={30 * stages.length + 40}>
            <BarChart
              data={stages}
              layout="vertical"
              margin={{ top: 4, right: 128, bottom: 4, left: 8 }}
              barCategoryGap={6}
            >
              {/* Hairline, solid, recessive. Dashed gridlines add texture that
                  competes with the bars for attention. */}
              <CartesianGrid
                horizontal={false}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <XAxis
                type="number"
                // dataMax, not recharts' auto domain. Auto rounds up to a
                // "nice" number - 4,765 became a 6,000 axis - which spends a
                // fifth of the plot width on empty space and shortens every
                // bar for nothing.
                domain={[0, 'dataMax']}
                tick={AXIS_TICK}
                stroke="var(--axis)"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={130}
                tick={AXIS_TICK}
                stroke="var(--axis)"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                content={<ChartTooltip suffix="postings" />}
                cursor={{ fill: CURSOR_FILL }}
              />
              <Bar
                dataKey="count"
                barSize={20}
                radius={[0, 4, 4, 0]}
                isAnimationActive={motion.active}
                animationDuration={motion.duration}
                animationEasing="ease-out"
                // A zero bar has no rectangle, and recharts skips the label of a
                // shape it did not draw - so the empty stages rendered as a bare
                // axis label with nothing beside it. A 2px stub gives the label
                // something to anchor to. It is drawn in muted ink rather than
                // the next ramp step precisely so it does not read as a small
                // quantity: 2px of grey plus the words "0 · phase 5" is the
                // encoding for absent, not for nearly-none.
                minPointSize={2}
                label={<FunnelValueLabel stages={stages} />}
              >
                {stages.map((stage, i) => (
                  <Cell
                    key={stage.key}
                    fill={
                      stage.count === 0
                        ? 'var(--ink-muted)'
                        : SEQ[Math.min(i, SEQ.length - 1)]
                    }
                    // 2px surface-coloured stroke: the gap between adjacent
                    // fills, so touching bars stay separate marks.
                    stroke="var(--surface-raised)"
                    strokeWidth={2}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Table
          head={
            <>
              <Th>Stage</Th>
              <Th numeric>Count</Th>
              <Th numeric>Of first stage</Th>
              <Th>Produced by</Th>
            </>
          }
        >
          {stages.map((s) => (
            <Tr key={s.key}>
              <Td className="text-[var(--ink-primary)]">{s.label}</Td>
              <Td numeric>{num(s.count)}</Td>
              <Td numeric>
                {first > 0 ? `${((s.count / first) * 100).toFixed(1)}%` : '—'}
              </Td>
              <Td>{s.phase}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/**
 * Match-score histogram. ONE hue, not a ramp: the bins are a single
 * distribution, so varying colour across them would encode a difference that
 * does not exist. Position along the axis already carries the score.
 */
export function ScoreHistogram({
  bins,
}: {
  bins: { bucket: number; label: string; count: number }[];
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const motion = useChartMotion();
  const total = bins.reduce((sum, b) => sum + b.count, 0);

  return (
    <Card>
      <CardHeader
        title="Match score distribution"
        subtitle="How well postings fit the profile, in 10-point bins"
        action={total > 0 ? <ViewToggle view={view} onChange={setView} /> : undefined}
      />
      {total === 0 ? (
        <EmptyState
          title="No postings scored yet"
          detail="Scoring needs the profile atoms and the LLM layer, so this stays empty until those land. An empty chart here is expected, not a failure."
          phase="phase 4"
        />
      ) : view === 'chart' ? (
        <div className="px-2 py-4">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={bins}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                stroke="var(--axis)"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={AXIS_TICK}
                stroke="var(--axis)"
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip
                content={<ChartTooltip suffix="postings" />}
                cursor={{ fill: CURSOR_FILL }}
              />
              <Bar
                dataKey="count"
                fill="var(--hist)"
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                stroke="var(--surface-raised)"
                strokeWidth={2}
                isAnimationActive={motion.active}
                animationDuration={motion.duration}
                animationEasing="ease-out"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Table
          head={
            <>
              <Th>Score</Th>
              <Th numeric>Postings</Th>
              <Th numeric>Share</Th>
            </>
          }
        >
          {bins.map((b) => (
            <Tr key={b.bucket}>
              <Td className="text-[var(--ink-primary)]">{b.label}</Td>
              <Td numeric>{num(b.count)}</Td>
              <Td numeric>{((b.count / total) * 100).toFixed(1)}%</Td>
            </Tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
