import type { Card as HulyCard, CardSpace as HulyCardSpace, MasterTag as HulyMasterTag } from "@hcengineering/card"
import {
  type Data,
  type DocumentQuery,
  type DocumentUpdate,
  generateId,
  type Ref,
  SortingOrder
} from "@hcengineering/core"
import { makeRank } from "@hcengineering/rank"
import { Effect, Schema } from "effect"

import type {
  CardDetail,
  CardSpaceSummary,
  CardSummary,
  CreateCardParams,
  CreateCardResult,
  DeleteCardParams,
  DeleteCardResult,
  GetCardParams,
  ListCardSpacesParams,
  ListCardSpacesResult,
  ListCardsParams,
  ListCardsResult,
  ListMasterTagsParams,
  ListMasterTagsResult,
  MasterTagSummary,
  UpdateCardParams,
  UpdateCardResult
} from "../../domain/schemas/cards.js"
import { UPDATE_CARD_FIELDS } from "../../domain/schemas/cards.js"
import { CardId, CardIdentifier, CardSpaceId, CardSpaceIdentifier, MasterTagId } from "../../domain/schemas/shared.js"
import { CardVersionMetadataDegradedWarningCode } from "../../domain/schemas/tool-warnings.js"
import { HulyClient, type HulyClientError } from "../client.js"
import { Diagnostics } from "../diagnostics.js"
import { CardNotFoundError, CardSpaceNotFoundError, HulyError } from "../errors.js"
import type { MasterTagNotFoundError, NoUpdateFieldsError } from "../errors.js"
import { cardPlugin } from "../huly-plugins.js"
import { fetchMasterTagsForSpace, findMasterTag, masterTagDisplayName } from "./card-master-tags.js"
import {
  cardVersionDegradedFields,
  cardVersionMetadataFromState,
  parseCardVersionMetadata
} from "./cards-version-history.js"
import { clearTextAsEmptyString } from "./clear-field-updates.js"
import { listTotal, optionalCount } from "./counts.js"
import { renderMarkdownPreservingNativeReferences } from "./native-reference-markup.js"
import { clampLimit, escapeLikeWildcards, findByNameOrId } from "./query-helpers.js"
import { toRef } from "./sdk-boundary.js"
import { type DirectUpdateEntry, mergeUpdateEntries, requireUpdateFields } from "./update-guards.js"

export { listCardVersions } from "./cards-version-history.js"

type ListCardSpacesError = HulyClientError

type ListMasterTagsError = HulyClientError | CardSpaceNotFoundError

type ListCardsError = HulyClientError | CardSpaceNotFoundError | MasterTagNotFoundError

type GetCardError = HulyClientError | HulyError | CardSpaceNotFoundError | CardNotFoundError

type CreateCardError = HulyClientError | HulyError | CardSpaceNotFoundError | MasterTagNotFoundError | CardNotFoundError

type UpdateCardError = HulyClientError | HulyError | NoUpdateFieldsError | CardSpaceNotFoundError | CardNotFoundError

type DeleteCardError = HulyClientError | HulyError | CardSpaceNotFoundError | CardNotFoundError

// --- Helpers ---

const parseResolvedCardSpaceIdentifier = (cardSpace: HulyCardSpace): Effect.Effect<CardSpaceIdentifier, HulyError> =>
  Schema.decodeUnknownEffect(CardSpaceIdentifier)(cardSpace.name).pipe(
    Effect.mapError((cause) => new HulyError({ message: "Resolved card space has an invalid name", cause }))
  )

const parseResolvedCardIdentifier = (card: HulyCard): Effect.Effect<CardIdentifier, HulyError> =>
  Schema.decodeUnknownEffect(CardIdentifier)(card.title).pipe(
    Effect.mapError((cause) => new HulyError({ message: "Resolved card has an invalid title", cause }))
  )

const findCardSpace = (
  identifier: CardSpaceIdentifier
): Effect.Effect<
  { cardSpace: HulyCardSpace; client: HulyClient["Service"] },
  CardSpaceNotFoundError | HulyClientError,
  HulyClient
> =>
  Effect.gen(function* () {
    const client = yield* HulyClient

    const cardSpace = yield* findByNameOrId(
      client,
      cardPlugin.class.CardSpace,
      { name: identifier, archived: false },
      { _id: toRef<HulyCardSpace>(identifier) }
    )

    if (cardSpace === undefined) {
      return yield* new CardSpaceNotFoundError({ identifier })
    }

    return { cardSpace, client }
  })

export const findCardSpaceAndCard = (
  params: Pick<GetCardParams, "card" | "cardSpace">
): Effect.Effect<
  {
    card: HulyCard
    cardIdentifier: CardIdentifier
    cardSpace: HulyCardSpace
    cardSpaceIdentifier: CardSpaceIdentifier
    client: HulyClient["Service"]
  },
  CardSpaceNotFoundError | CardNotFoundError | HulyClientError | HulyError,
  HulyClient
> =>
  Effect.gen(function* () {
    const { cardSpace, client } = yield* findCardSpace(params.cardSpace)
    const cardSpaceIdentifier = yield* parseResolvedCardSpaceIdentifier(cardSpace)

    const card = yield* findByNameOrId(
      client,
      cardPlugin.class.Card,
      { space: cardSpace._id, title: params.card },
      { space: cardSpace._id, _id: toRef<HulyCard>(params.card) }
    )

    if (card === undefined) {
      return yield* new CardNotFoundError({ identifier: params.card, cardSpace: cardSpaceIdentifier })
    }

    const cardIdentifier = yield* parseResolvedCardIdentifier(card)
    return { card, cardIdentifier, cardSpace, cardSpaceIdentifier, client }
  })

// --- Operations ---

export const listCardSpaces = (
  params: ListCardSpacesParams
): Effect.Effect<ListCardSpacesResult, ListCardSpacesError, HulyClient> =>
  Effect.gen(function* () {
    const client = yield* HulyClient

    const query: DocumentQuery<HulyCardSpace> = {}
    if (!params.includeArchived) {
      query.archived = false
    }

    const limit = clampLimit(params.limit)

    const spaces = yield* client.findAll<HulyCardSpace>(cardPlugin.class.CardSpace, query, {
      limit,
      sort: { name: SortingOrder.Ascending }
    })

    const summaries: Array<CardSpaceSummary> = spaces.map((s) => ({
      id: CardSpaceId.make(s._id),
      name: s.name,
      description: s.description || undefined,
      types: s.types.map(String)
    }))

    return { cardSpaces: summaries, total: listTotal(spaces.total) }
  })

export const listMasterTags = (
  params: ListMasterTagsParams
): Effect.Effect<ListMasterTagsResult, ListMasterTagsError, HulyClient> =>
  Effect.gen(function* () {
    const { cardSpace, client } = yield* findCardSpace(params.cardSpace)

    const tags = yield* fetchMasterTagsForSpace(client, cardSpace)

    const summaries: Array<MasterTagSummary> = tags.map((t) => ({
      id: MasterTagId.make(t._id),
      name: masterTagDisplayName(t)
    }))

    return { masterTags: summaries, total: listTotal(summaries.length) }
  })

export const listCards = (params: ListCardsParams): Effect.Effect<ListCardsResult, ListCardsError, HulyClient> =>
  Effect.gen(function* () {
    const { cardSpace, client } = yield* findCardSpace(params.cardSpace)

    const limit = clampLimit(params.limit)

    const query: DocumentQuery<HulyCard> = { space: cardSpace._id }

    if (params.type !== undefined) {
      const masterTag = yield* findMasterTag(client, cardSpace, params.type)
      query._class = masterTag._id
    }

    if (params.titleSearch !== undefined && params.titleSearch.trim() !== "") {
      query.title = { $like: `%${escapeLikeWildcards(params.titleSearch)}%` }
    }

    if (params.titleRegex !== undefined && params.titleRegex.trim() !== "") {
      query.title = { $regex: params.titleRegex }
    }

    if (params.contentSearch !== undefined && params.contentSearch.trim() !== "") {
      query.$search = params.contentSearch
    }

    const cards = yield* client.findAll<HulyCard>(cardPlugin.class.Card, query, {
      limit,
      sort: { modifiedOn: SortingOrder.Descending }
    })

    const summaries: Array<CardSummary> = cards.map((c) => ({
      id: CardId.make(c._id),
      title: c.title,
      type: String(c._class),
      modifiedOn: c.modifiedOn
    }))

    return { cards: summaries, total: listTotal(cards.total) }
  })

export const getCard = (params: GetCardParams): Effect.Effect<CardDetail, GetCardError, HulyClient | Diagnostics> =>
  Effect.gen(function* () {
    const diagnostics = yield* Diagnostics
    const { card, cardIdentifier, cardSpaceIdentifier, client } = yield* findCardSpaceAndCard({
      card: params.card,
      cardSpace: params.cardSpace
    })

    const content: string | undefined = card.content
      ? yield* client.fetchMarkup(card._class, card._id, "content", card.content, "markdown")
      : undefined
    const parsedVersion = parseCardVersionMetadata(card)
    const degradedVersionFields = cardVersionDegradedFields(parsedVersion)
    if (degradedVersionFields.length > 0) {
      yield* diagnostics.warnAgent({
        code: CardVersionMetadataDegradedWarningCode,
        message:
          `Card '${card._id}' has degraded version metadata because these fields are absent or malformed: ` +
          `${degradedVersionFields.join(", ")}. Treat omitted version data as incomplete and inspect or ` +
          "repair the Huly card data."
      })
    }
    const version = cardVersionMetadataFromState(parsedVersion)

    return {
      id: CardId.make(card._id),
      title: cardIdentifier,
      content,
      type: String(card._class),
      parent: card.parent ? String(card.parent) : undefined,
      children: optionalCount(card.children),
      cardSpace: cardSpaceIdentifier,
      ...(version === undefined ? {} : { version }),
      modifiedOn: card.modifiedOn,
      createdOn: card.createdOn
    }
  })

export const createCard = (params: CreateCardParams): Effect.Effect<CreateCardResult, CreateCardError, HulyClient> =>
  Effect.gen(function* () {
    const { cardSpace, client } = yield* findCardSpace(params.cardSpace)

    const masterTag = yield* findMasterTag(client, cardSpace, params.type)

    const cardId: Ref<HulyCard> = generateId()

    const lastCard = yield* client.findOne<HulyCard>(
      cardPlugin.class.Card,
      { space: cardSpace._id },
      { sort: { rank: SortingOrder.Descending } }
    )
    const rank = makeRank(lastCard?.rank, undefined)

    // Card.content is non-nullable MarkupBlobRef — always upload content
    const renderedContent = renderMarkdownPreservingNativeReferences(params.content ?? "", client.markupUrlConfig)
    const contentMarkupRef = yield* client.uploadMarkup(
      masterTag._id,
      cardId,
      "content",
      renderedContent.markup,
      renderedContent.format
    )

    type CardParentData = {
      parentRef: Ref<HulyCard> | null
      parentInfo: Array<{ _id: Ref<HulyCard>; _class: Ref<HulyMasterTag>; title: string }>
    }
    const parentParam = params.parent
    const { parentInfo, parentRef }: CardParentData =
      parentParam !== undefined
        ? yield* Effect.gen(function* () {
            const parentCard = yield* findByNameOrId(
              client,
              cardPlugin.class.Card,
              { space: cardSpace._id, title: parentParam },
              { space: cardSpace._id, _id: toRef<HulyCard>(parentParam) }
            )
            if (parentCard === undefined) {
              const resolvedCardSpaceIdentifier = yield* parseResolvedCardSpaceIdentifier(cardSpace)
              return yield* new CardNotFoundError({ identifier: parentParam, cardSpace: resolvedCardSpaceIdentifier })
            }
            return {
              parentRef: parentCard._id,
              parentInfo: [
                ...parentCard.parentInfo,
                { _id: parentCard._id, _class: parentCard._class, title: parentCard.title }
              ]
            }
          })
        : { parentRef: null, parentInfo: [] }

    const cardData: Data<HulyCard> = {
      title: params.title,
      content: contentMarkupRef,
      blobs: {},
      parentInfo,
      parent: parentRef,
      rank
    }

    yield* client.createDoc(masterTag._id, cardSpace._id, cardData, cardId)

    return { id: CardId.make(cardId), title: params.title }
  })

export const updateCard = (params: UpdateCardParams): Effect.Effect<UpdateCardResult, UpdateCardError, HulyClient> =>
  Effect.gen(function* () {
    yield* requireUpdateFields("update_card", params, UPDATE_CARD_FIELDS)

    const { card, cardSpace, client } = yield* findCardSpaceAndCard({ card: params.card, cardSpace: params.cardSpace })

    type UpdateCardField = (typeof UPDATE_CARD_FIELDS)[number]
    type UpdateCardEntries = {
      readonly [Field in UpdateCardField]: Effect.Effect<
        DirectUpdateEntry<UpdateCardField, DocumentUpdate<HulyCard>, Field>,
        HulyClientError
      >
    }
    const updateEntries = {
      title: Effect.succeed(params.title === undefined ? {} : { title: params.title }),
      content: Effect.gen(function* () {
        if (params.content === undefined) return {}
        const content = clearTextAsEmptyString(params.content)
        const renderedContent = renderMarkdownPreservingNativeReferences(content, client.markupUrlConfig)
        // Card.content is non-nullable MarkupBlobRef (unlike Document.content which can be null).
        // Empty string clears the content blob rather than nulling the field.
        if (card.content) {
          yield* client.updateMarkup(card._class, card._id, "content", renderedContent.markup, renderedContent.format)
          return {}
        }
        const contentMarkupRef = yield* client.uploadMarkup(
          card._class,
          card._id,
          "content",
          renderedContent.markup,
          renderedContent.format
        )
        return { content: contentMarkupRef }
      })
    } satisfies UpdateCardEntries
    const updateOps: DocumentUpdate<HulyCard> = mergeUpdateEntries(yield* Effect.all(Object.values(updateEntries)))

    if (Object.keys(updateOps).length > 0) {
      yield* client.updateDoc(card._class, cardSpace._id, card._id, updateOps)
    }

    return { id: CardId.make(card._id), updated: true }
  })

export const deleteCard = (params: DeleteCardParams): Effect.Effect<DeleteCardResult, DeleteCardError, HulyClient> =>
  Effect.gen(function* () {
    const { card, cardSpace, client } = yield* findCardSpaceAndCard({ card: params.card, cardSpace: params.cardSpace })

    yield* client.removeDoc(card._class, cardSpace._id, card._id)

    return { id: CardId.make(card._id), deleted: true }
  })
