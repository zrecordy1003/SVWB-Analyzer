import { PrismaClient, Deck } from '@prisma/client'
export const prisma = new PrismaClient()

export const getDecks = (): Promise<Deck[]> => prisma.deck.findMany()

export const addDeck = (name: string, svClass: string): Promise<Deck> =>
  prisma.deck.create({ data: { name, class: svClass } })
