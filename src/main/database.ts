import { Deck, Match, ClassName, PlayOrder, GameMode } from '@prisma/client'
import { getPrisma } from './db/prismaClient.js'

export async function getDecks(): Promise<Deck[]> {
  const prisma = getPrisma()
  return prisma.deck.findMany()
}

export async function addDeck(name: string, svClass: string): Promise<Deck> {
  const prisma = getPrisma()
  return prisma.deck.create({ data: { name, class: svClass } })
}

export async function fetchMatchCount(): Promise<number> {
  const prisma = getPrisma()
  return prisma.match.count()
}

export async function fetchLastMatch(): Promise<Match | null> {
  const prisma = getPrisma()
  const latest = await prisma.match.findFirst({
    orderBy: { playedAt: 'desc' }
  })
  return latest ?? null
}

export async function fetchMatchesCursor(take: number, cursorId?: number): Promise<Match[]> {
  const prisma = getPrisma()
  return prisma.match.findMany({
    where: { result: { not: null } },
    orderBy: { playedAt: 'desc' },
    take,
    ...(cursorId
      ? {
          cursor: { id: cursorId },
          skip: 1
        }
      : {})
  })
}

export async function addMatch(
  my_class: ClassName,
  oppo_class: ClassName,
  play_order: PlayOrder
): Promise<Match> {
  const prisma = getPrisma()
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const day = now.getDate()

  return prisma.match.create({
    data: {
      result: null,
      play_order,
      my_class,
      oppo_class,
      my_deckId: null,
      oppo_deckId: null,
      year,
      month,
      day
    }
  })
}

export async function modifyMatchResult(result: boolean): Promise<Match> {
  const prisma = getPrisma()
  const latest = await prisma.match.findFirst({
    orderBy: { playedAt: 'desc' }
  })
  if (!latest) {
    // 視需求：回傳錯、忽略、或直接建立一筆
    throw new Error('No match to update result.')
  }

  const now = new Date()
  const durationSecs = Math.floor((now.getTime() - latest.playedAt.getTime()) / 1000)

  return prisma.match.update({
    where: { id: latest.id },
    data: { result, endedAt: now, durationTime: durationSecs }
  })
}

export async function modifyMatchMode(mode: GameMode | null): Promise<Match> {
  const prisma = getPrisma()
  const latest = await prisma.match.findFirst({
    orderBy: { playedAt: 'desc' }
  })
  if (!latest) throw new Error('No match to update mode.')

  if (latest.endedAt === null) {
    const now = new Date()
    const durationSecs = Math.floor((now.getTime() - latest.playedAt.getTime()) / 1000)
    return prisma.match.update({
      where: { id: latest.id },
      data: { mode, endedAt: now, durationTime: durationSecs }
    })
  }
  return prisma.match.update({ where: { id: latest.id }, data: { mode } })
}

export async function modifyMatchBP(bp: number | null): Promise<Match> {
  const prisma = getPrisma()
  const latest = await prisma.match.findFirst({
    orderBy: { playedAt: 'desc' }
  })
  if (!latest) throw new Error('No match to update BP.')

  return prisma.match.update({
    where: { id: latest.id },
    data: { bp }
  })
}
