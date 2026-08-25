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

  return prisma.$transaction(async (tx) => {
    const [myDefault] = await Promise.all([
      tx.deck.findFirst({ where: { class: my_class, isDefault: true }, select: { id: true } }),
      tx.deck.findFirst({ where: { class: oppo_class, isDefault: true }, select: { id: true } })
    ])

    return tx.match.create({
      data: {
        result: null,
        play_order,
        my_class,
        oppo_class,
        my_deckId: myDefault?.id ?? null,
        oppo_deckId: null,
        year,
        month,
        day
      }
    })
  })
}

export async function clearMyDeck(matchId: number): Promise<Match> {
  const prisma = getPrisma()
  return prisma.match.update({
    where: { id: matchId },
    data: { my_deckId: null }
  })
}

export async function modifyMatchResult(matchId: number, result: boolean): Promise<Match> {
  const prisma = getPrisma()
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } })

  const now = new Date()
  const durationSecs = Math.floor((now.getTime() - match.playedAt.getTime()) / 1000)

  return prisma.match.update({
    where: { id: matchId },
    data: { result, endedAt: now, durationTime: durationSecs }
  })
}

export async function modifyMatchMode(matchId: number, mode: GameMode | null): Promise<Match> {
  const prisma = getPrisma()
  return prisma.match.update({ where: { id: matchId }, data: { mode } })
}

export async function modifyMatchBP(matchId: number, bp: number | null): Promise<Match> {
  const prisma = getPrisma()
  return prisma.match.update({
    where: { id: matchId },
    data: { bp }
  })
}

export async function modifyMatchDeltaCR(matchId: number, delta_cr: number | null): Promise<Match> {
  const prisma = getPrisma()
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } })

  if (match.current_cr !== null && delta_cr !== null) {
    return prisma.match.update({
      where: { id: matchId },
      data: {
        delta_cr,
        current_cr:
          delta_cr > 0 ? match.current_cr - delta_cr : match.current_cr + Math.abs(delta_cr)
      }
    })
  }

  return prisma.match.update({
    where: { id: matchId },
    data: { delta_cr }
  })
}

export async function modifyMatchCurrentCR(
  matchId: number,
  current_cr: number | null
): Promise<Match> {
  const prisma = getPrisma()
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } })

  if (match.delta_cr !== null && current_cr !== null) {
    return prisma.match.update({
      where: { id: matchId },
      data: {
        current_cr:
          match.delta_cr > 0 ? current_cr - match.delta_cr : current_cr + Math.abs(match.delta_cr)
      }
    })
  }

  return prisma.match.update({
    where: { id: matchId },
    data: { current_cr }
  })
}
