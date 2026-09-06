"use client"

/**
 * The chart primitives the console's one graph mounts on (shadcn/ui's chart
 * wrapper, radar flavour). The class names were adapted from shadcn's
 * `muted-fg` / `overlay` / `border` / `fg` tokens to this codebase's console
 * tokens (`c-muted`, `c-card`, `c-line`, `c-ink`): a component pasted from
 * another design system that ships its own palette would render unthemed
 * boxes in light mode and invisible ones in dark, because the tokens it names
 * do not exist in globals.css.
 *
 * Everything else is the stock wrapper: a context carrying the series→colour
 * config, a <style> tag emitting `--color-<key>` per series so series can
 * paint themselves with `var(--color-score)`, and themed tooltip/legend
 * bodies. Recharts renders the actual SVG.
 */

import { createContext, use, useId, useMemo } from "react"

import type { LegendPayload } from "recharts"
import type { TooltipPayloadEntry } from "recharts"
import { Legend, ResponsiveContainer, Tooltip } from "recharts"
import { twMerge } from "tailwind-merge"

const THEMES = { light: "", dark: ".dark" } as const

type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
}

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = createContext<ChartContextProps | null>(null)

function useChart() {
  const context = use(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <Chart />")
  }

  return context
}

const Chart = ({
  id,
  className,
  children,
  config,
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<typeof ResponsiveContainer>["children"]
}) => {
  const uniqueId = useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        ref={ref}
        className={twMerge(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-c-muted [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-c-line/80 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-c-line [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-c-line [&_.recharts-radial-bar-background-sector]:fill-c-soft [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-c-soft [&_.recharts-reference-line_[stroke='#ccc']]:stroke-c-line [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([_, config]) => config.theme || config.color)

  if (!colorConfig.length) {
    return null
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .join("\n")}
}
`,
          )
          .join("\n"),
      }}
    />
  )
}

const ChartTooltip = Tooltip

const ChartTooltipContent = ({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
  ref,
}: React.ComponentProps<typeof Tooltip> &
  React.ComponentProps<"div"> & {
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: "line" | "dot" | "dashed"
    nameKey?: string
    labelKey?: string
    /**
     * Injected by recharts when it renders this as the tooltip's content.
     * Recharts v3 omits them from its public Tooltip props (it reads them
     * from internal state), so they are typed here rather than inherited.
     */
    payload?: TooltipPayloadEntry[]
    label?: unknown
  }) => {
  const { config } = useChart()

  const tooltipLabel = useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }

    const [item] = payload

    if (!item) {
      return null
    }

    const key = `${labelKey || item.dataKey || item.name || "value"}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === "string"
        ? config[label as keyof typeof config]?.label || label
        : itemConfig?.label

    if (labelFormatter) {
      return <div className={labelClassName}>{labelFormatter(value, payload)}</div>
    }

    if (!value) {
      return null
    }

    return <div className={labelClassName}>{value}</div>
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    <div
      ref={ref}
      className={twMerge(
        "grid min-w-[12rem] items-start gap-1.5 rounded-lg border border-c-line bg-c-card px-3 py-2 text-c-ink text-xs shadow-xl",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = `${nameKey || item.name || item.dataKey || "value"}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)
          const indicatorColor = color || item.payload.fill || item.color

          return (
            <div
              key={String(item.dataKey ?? index)}
              className={twMerge(
                "flex w-full flex-wrap items-stretch gap-2 *:data-[slot=icon]:size-2.5 *:data-[slot=icon]:text-c-muted",
                indicator === "dot" && "items-center",
              )}
            >
              {formatter && item?.value !== undefined && item.name ? (
                formatter(item.value, item.name, item, index, item.payload)
              ) : (
                <>
                  {itemConfig?.icon ? (
                    <itemConfig.icon />
                  ) : (
                    !hideIndicator && (
                      <div
                        className={twMerge(
                          "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                          indicator === "dot" && "size-2.5",
                          indicator === "line" && "w-1",
                          indicator === "dashed" &&
                            "w-0 border-[1.5px] border-dashed bg-transparent",
                          nestLabel && indicator === "dashed" && "my-0.5",
                        )}
                        style={
                          {
                            "--color-bg": indicatorColor,
                            "--color-border": indicatorColor,
                          } as React.CSSProperties
                        }
                      />
                    )
                  )}
                  <div
                    className={twMerge(
                      "flex flex-1 justify-between leading-none",
                      nestLabel ? "items-end" : "items-center",
                    )}
                  >
                    <div className="grid gap-1.5">
                      {nestLabel ? tooltipLabel : null}
                      <span className="text-c-muted">{itemConfig?.label || item.name}</span>
                    </div>
                    {item.value && (
                      <span className="font-medium font-mono text-c-ink tabular-nums">
                        {item.value.toLocaleString()}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ChartLegend = Legend

const ChartLegendContent = ({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
  ref,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean
  nameKey?: string
  /**
   * Injected by recharts when it clones this as the Legend's content — the
   * same story as the tooltip's payload above: runtime-injected, so typed
   * here instead of picked from LegendProps (which omits it in v3).
   */
  payload?: LegendPayload[]
  verticalAlign?: "top" | "bottom"
}) => {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div
      ref={ref}
      className={twMerge(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload.map((item) => {
        const key = `${nameKey || item.dataKey || "value"}`
        const itemConfig = getPayloadConfigFromPayload(config, item, key)

        return (
          <div
            key={item.value}
            className="flex items-center gap-1.5 *:data-[slot=icon]:size-3 *:data-[slot=icon]:text-c-muted"
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: item.color,
                }}
              />
            )}
            {itemConfig?.label}
          </div>
        )
      })}
    </div>
  )
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const payloadPayload =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string
  }

  return configLabelKey in config ? config[configLabelKey] : config[key as keyof typeof config]
}

export type { ChartConfig }
export { Chart, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, ChartStyle }
