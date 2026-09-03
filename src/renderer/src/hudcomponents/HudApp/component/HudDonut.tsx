/**
 * The HUD's win/loss ring, split out so `chart.js` can be loaded on demand.
 *
 * `chart.js` + `react-chartjs-2` are 128KB and this is their only consumer in
 * the whole app. While the import sat in `HudInsights` they were part of the
 * eager graph of *both* entries - the HUD paid for them before it knew whether
 * there was a single completed match to draw, and the main window paid for
 * them because React shared their chunk (see `manualChunks` in
 * `electron.vite.config.ts`).
 *
 * Lazily importing this file means the ring's code arrives with the first
 * ring. The HUD is a long-lived window, so that happens once per session.
 */
import React from 'react'
import { Doughnut } from 'react-chartjs-2'
import { ArcElement, Chart as ChartJS, DoughnutController } from 'chart.js'

ChartJS.register(ArcElement, DoughnutController)

export type HudDonutProps = {
  wins: number
  losses: number
  winColor: string
  lossColor: string
}

/**
 * The percentage in the middle of the ring, drawn on the canvas rather than
 * laid over it: a DOM overlay would need its own centring against a canvas
 * that resizes with the HUD.
 */
const donutCenterPlugin = {
  id: 'hudDonutCenter',
  afterDraw(chart: ChartJS) {
    const { ctx, chartArea } = chart
    const values = (chart.data.datasets[0]?.data ?? []) as number[]
    const total = values.reduce<number>((sum, value) => sum + Number(value), 0)
    if (!total) return
    const wins = Number(chart.data.datasets[0]?.data[0] ?? 0)
    const rate = Math.round((wins / total) * 100)
    const x = (chartArea.left + chartArea.right) / 2
    const y = (chartArea.top + chartArea.bottom) / 2

    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#F2F5F8'
    ctx.font = '800 19px "Segoe UI", sans-serif'
    // The figure stands alone: the ring around it is already a win/loss split.
    ctx.fillText(`${rate}%`, x, y)
    ctx.restore()
  }
}

const HudDonut: React.FC<HudDonutProps> = ({ wins, losses, winColor, lossColor }) => (
  <Doughnut
    data={{
      labels: ['勝利', '敗北'],
      datasets: [
        {
          data: [wins, losses],
          backgroundColor: [winColor, lossColor],
          borderColor: ['rgba(117,226,168,0.22)', 'rgba(242,140,140,0.22)'],
          borderWidth: 1,
          hoverOffset: 0,
          spacing: 2
        }
      ]
    }}
    plugins={[donutCenterPlugin]}
    options={{
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 360 },
      events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }}
  />
)

export default HudDonut
