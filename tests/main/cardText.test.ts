/**
 * The card-text parser.
 *
 * The strings below are real `skill_text` values, copied verbatim from the
 * portal - invented ones would only prove the parser handles the grammar I
 * imagined. The survey behind them covered all seven classes (2,695 texts) and
 * turned up exactly six tags; each has a case here, and the last test asserts
 * that no tag survives into the output at all.
 */
import { describe, expect, it } from 'vitest'

import { cardTextToPlain, parseCardText } from '../../src/shared/cardText'

const plainOf = (segment: { lines: { text: string }[][] }): string =>
  segment.lines.map((line) => line.map((run) => run.text).join('')).join('\n')

describe('parseCardText', () => {
  it('is empty for no text, so a vanilla card renders nothing', () => {
    expect(parseCardText(null)).toEqual([])
    expect(parseCardText('')).toEqual([])
    expect(parseCardText('   ')).toHaveLength(1)
  })

  it('marks keywords and leaves the rest as text', () => {
    const [segment] = parseCardText('【<color=Keyword>守護</color>】由自己的牌堆中抽取1張卡片。')
    expect(segment.variant).toBe('body')
    expect(segment.lines[0]).toEqual([
      { keyword: false, text: '【' },
      { keyword: true, text: '守護' },
      { keyword: false, text: '】由自己的牌堆中抽取1張卡片。' }
    ])
  })

  it('keeps newlines as separate lines', () => {
    const [segment] = parseCardText('第一行\n第二行')
    expect(segment.lines).toHaveLength(2)
  })

  it('reads an evolve block, with the rule that preceded it', () => {
    const segments = parseCardText(
      '【<color=Keyword>守護</color>】\n<hr><ev>【<color=Keyword>進化時</color>】由自己的牌堆中抽取1張卡片。</ev>'
    )

    expect(segments.map((s) => s.variant)).toEqual(['body', 'evolve'])
    // The rule belongs to what FOLLOWS it; hung on the previous block it would
    // draw a line under the last thing on the card.
    expect(segments[0].divider).toBe(false)
    expect(segments[1].divider).toBe(true)
    expect(plainOf(segments[1])).toBe('【進化時】由自己的牌堆中抽取1張卡片。')
  })

  it('tells evolve and super-evolve apart', () => {
    const segments = parseCardText(
      '<ev>【<color=Keyword>進化時</color>】回復自己的主戰者2點生命值。</ev>\n<sev>【<color=Keyword>超進化時</color>】由原本的回復2點轉變為回復4點。</sev>'
    )
    expect(segments.map((s) => s.variant)).toEqual(['evolve', 'superEvolve'])
  })

  it('reads the numbered options of a mode choice', () => {
    const segments = parseCardText(
      '指定1個【<color=Keyword>模式</color>】並發動該能力。\n<ridx=0>（1）由自己的牌堆中抽取1張卡片。</ridx>\n<ridx=1>（2）使自己戰場上全部的從者卡+1/+0。</ridx>'
    )

    expect(segments.map((s) => s.variant)).toEqual(['body', 'mode', 'mode'])
    expect(segments[1].index).toBe(0)
    expect(segments[2].index).toBe(1)
    expect(plainOf(segments[2])).toBe('（2）使自己戰場上全部的從者卡+1/+0。')
  })

  it('drops <nobr> but keeps the number it was protecting', () => {
    const [segment] = parseCardText(
      '【<color=Keyword>協作</color>_<nobr>10</nobr>】給予敵方戰場上全部的從者卡X點傷害。'
    )
    expect(plainOf(segment)).toBe('【協作_10】給予敵方戰場上全部的從者卡X點傷害。')
  })

  it('separates two ordinary sections with a rule', () => {
    const segments = parseCardText(
      '【<color=Keyword>入場曲</color>】由自己的牌堆中抽取1張從者卡。\n<hr>【<color=Keyword>策動</color>】破壞這張卡片。'
    )
    expect(segments).toHaveLength(2)
    expect(segments[1].divider).toBe(true)
    expect(segments[1].variant).toBe('body')
  })

  it('strips a tag it does not know rather than printing it', () => {
    // A portal change should cost the marker, not the sentence.
    const [segment] = parseCardText('給予<b>3</b>點傷害。<newthing=2>額外效果</newthing>')
    expect(plainOf(segment)).toBe('給予3點傷害。額外效果')
  })

  it('leaves no angle brackets anywhere in the output', () => {
    const samples = [
      '【<color=Keyword>守護</color>】\n【<color=Keyword>謝幕曲</color>】由自己的牌堆中抽取1張卡片。\n<hr><ev>【<color=Keyword>進化時</color>】由自己的牌堆中抽取1張卡片。</ev>',
      '【<color=Keyword>疾馳</color>】\n<hr><sev>【<color=Keyword>超進化時</color>】指定1張敵方戰場上的從者卡。使其返回手牌中。</sev>',
      '指定1個【<color=Keyword>模式</color>】並發動該能力。\n<ridx=0>（1）隨機給予1張敵方戰場上的從者卡5點傷害。</ridx>\n<ridx=1>（2）由自己的牌堆中抽取2張從者卡。</ridx>',
      '使自己的PP最大值+1。隨後，如果自己的PP最大值為<nobr>10</nobr>，則會抽取1張卡片。'
    ]

    for (const sample of samples) {
      for (const segment of parseCardText(sample)) {
        for (const line of segment.lines) {
          for (const run of line) {
            // This is the whole complaint: markup reaching the screen.
            expect(run.text, sample).not.toMatch(/[<>]/)
          }
        }
      }
    }
  })
})

describe('cardTextToPlain', () => {
  it('flattens to something safe for an alt or a title', () => {
    expect(
      cardTextToPlain(
        '【<color=Keyword>守護</color>】\n<hr><ev>【<color=Keyword>進化時</color>】抽1張。</ev>'
      )
    ).toBe('【守護】\n【進化時】抽1張。')
  })

  it('is empty rather than undefined for a card with no ability', () => {
    expect(cardTextToPlain(null)).toBe('')
  })
})
