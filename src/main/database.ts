import { PrismaClient, Deck, Match, ClassName, PlayOrder, GameMode } from '@prisma/client'
export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'file:./dev.db'
    }
  }
})

export const getDecks = (): Promise<Deck[]> => prisma.deck.findMany()

export const addDeck = (name: string, svClass: string): Promise<Deck> =>
  prisma.deck.create({ data: { name, class: svClass } })

export const fetchMatchCount = (): Promise<number> => prisma.match.count()

export const fetchLastMatch = (): Promise<Match | null> =>
  prisma.match.findFirst({ orderBy: { playedAt: 'desc' } })

export const fetchMatchesCursor = (take: number, cursorId?: number): Promise<Match[]> => {
  return prisma.match.findMany({
    where: { result: { not: null } },
    orderBy: { playedAt: 'desc' },
    take, // 取幾筆
    ...(cursorId && {
      // 如果提供 cursorId，就從那筆之後再取
      cursor: { id: cursorId },
      skip: 1 // 跳過 cursor 本身
    })
  })
}

export const addMatch = (
  my_class: ClassName,
  oppo_class: ClassName,
  play_order: PlayOrder
): Promise<Match> => {
  // 1. 取現在時間
  const now = new Date()
  // 2. 拆成三個欄位
  const year = now.getFullYear() // e.g. 2025
  const month = now.getMonth() + 1 // JS 的 month 從 0–11，所以 +1
  const day = now.getDate() // 1–31

  // 3. 存到資料庫
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

export const modifyMatchResult = async (result: boolean, mode: GameMode): Promise<Match> => {
  const latest = await prisma.match.findFirstOrThrow({
    orderBy: { playedAt: 'desc' }
  })

  const now = new Date()
  const durationMs = now.getTime() - latest.playedAt.getTime()
  const durationSecs = Math.floor(durationMs / 1000)

  return prisma.match.update({
    where: { id: latest.id },
    data: { result, endedAt: now, durationTime: durationSecs, mode }
  })
}

export const gainBP = async (bp: number | null): Promise<Match> => {
  const latest = await prisma.match.findFirstOrThrow({
    orderBy: { playedAt: 'desc' }
  })

  return prisma.match.update({
    where: { id: latest.id },
    data: { bp }
  })
}
