import { PrismaClient, Deck, Match } from '@prisma/client'
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
  my_class: string,
  oppo_class: string,
  play_order: string
): Promise<Match> =>
  prisma.match.create({
    data: { result: null, play_order, my_class, oppo_class, my_deckId: null, oppo_deckId: null }
  })

export const modifyMatchResult = async (result: boolean): Promise<Match> => {
  const latest = await prisma.match.findFirstOrThrow({
    orderBy: { playedAt: 'desc' }
  })

  return prisma.match.update({
    where: { id: latest.id },
    data: { result, endedAt: new Date() }
  })
}
