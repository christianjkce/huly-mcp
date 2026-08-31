import { assertAt } from "../../../src/utils/assertions.js"
/* eslint-disable no-restricted-syntax -- test fixtures build Huly SDK docs whose nominal types are not structurally compatible with plain object literals, and branded refs have no runtime constructors */
import { describe, it } from "@effect/vitest"
import type { Card as HulyCard, CardSpace as HulyCardSpace, MasterTag as HulyMasterTag } from "@hcengineering/card"
import { ClassifierKind, type Doc, type Ref, toFindResult } from "@hcengineering/core"
import { Effect } from "effect"
import { expect } from "vitest"

import { CardIdentifier, CardSpaceIdentifier, MasterTagIdentifier } from "../../../src/domain/schemas/shared.js"
import { HulyClient, type HulyClientOperations } from "../../../src/huly/client.js"
import { Diagnostics, makeDiagnosticsScope } from "../../../src/huly/diagnostics.js"
import { CardNotFoundError, HulyError } from "../../../src/huly/errors.js"
import { cardPlugin, core } from "../../../src/huly/huly-plugins.js"
import {
  createCard,
  deleteCard,
  getCard,
  listCards,
  listCardSpaces,
  listCardVersions,
  listMasterTags,
  updateCard
} from "../../../src/huly/operations/cards.js"
import { withDiagnostics } from "../../helpers/diagnostics.js"
import { capturedMarkupChildNodes, capturedMarkupReferenceNodes } from "../../helpers/markup-capture.js"

const SPACE_ID = "space-1" as Ref<HulyCardSpace>
const TAG_ID = "tag-1" as Ref<HulyMasterTag>
const CHILD_TAG_ID = "tag-child-1" as Ref<HulyMasterTag>
const OTHER_TAG_ID = "tag-other-1" as Ref<HulyMasterTag>

const tagLabel = (value: string): HulyMasterTag["label"] => value as HulyMasterTag["label"]

const makeSpace = (overrides?: Partial<HulyCardSpace>): HulyCardSpace =>
  ({
    _id: SPACE_ID,
    _class: cardPlugin.class.CardSpace,
    name: "Cards",
    description: "Card space",
    archived: false,
    private: false,
    members: [],
    types: [TAG_ID],
    modifiedOn: 100,
    createdOn: 50,
    ...overrides
  }) as unknown as HulyCardSpace

const makeTag = (overrides?: Partial<HulyMasterTag>): HulyMasterTag =>
  ({
    _id: TAG_ID,
    _class: cardPlugin.class.MasterTag,
    label: "Document",
    kind: ClassifierKind.CLASS,
    extends: cardPlugin.class.Card,
    ...overrides
  }) as unknown as HulyMasterTag

const makeCard = (overrides?: Partial<HulyCard>): HulyCard =>
  ({
    _id: "card-1" as Ref<HulyCard>,
    _class: TAG_ID,
    space: SPACE_ID,
    title: "Roadmap",
    content: "content-blob",
    parent: null,
    parentInfo: [],
    children: 0,
    blobs: {},
    modifiedOn: 200,
    createdOn: 150,
    ...overrides
  }) as unknown as HulyCard

// Intentionally bypass the SDK's static Card contract to exercise malformed data returned by the external Huly boundary.
const malformedCardBoundaryFixture = (value: unknown): HulyCard => value as HulyCard

interface RuntimeCardVersionFields {
  readonly baseId?: Ref<Doc> | null
  readonly version?: number | null
  readonly isLatest?: boolean | null
  readonly readonly?: boolean | null
}

const makeVersionableCard: (overrides?: Partial<HulyCard> & RuntimeCardVersionFields) => HulyCard = makeCard

const idMatches = (actual: unknown, query: unknown): boolean => {
  if (query === undefined) return true
  if (typeof query === "object" && query !== null) {
    if ("$in" in query) {
      return Array.isArray(query.$in) && query.$in.includes(actual)
    }
    if ("$exists" in query) {
      return query.$exists === (actual !== undefined)
    }
  }
  return actual === query
}

const docMatches = (doc: object, query: Record<string, unknown>): boolean =>
  Object.entries(query).every(([key, value]) => idMatches(Reflect.get(doc, key), value))

interface CapturedFindOptions {
  readonly limit?: number
  readonly sort?: unknown
}

interface Captures {
  findAll?: { class?: unknown; query?: Record<string, unknown>; options?: CapturedFindOptions | undefined }
  findAllCalls?: Array<{ readonly class: unknown; readonly query: Record<string, unknown> }>
  createDoc?: { class?: unknown; space?: unknown; attributes?: Record<string, unknown>; id?: unknown }
  updateDoc?: { called?: boolean; operations?: Record<string, unknown> }
  removeDoc?: { called?: boolean; id?: unknown }
  uploadMarkup?: { called?: boolean; value?: string }
  updateMarkup?: { called?: boolean; value?: string }
}

interface CardsMock {
  spaces?: ReadonlyArray<HulyCardSpace>
  cards?: ReadonlyArray<HulyCard>
  masterTags?: ReadonlyArray<HulyMasterTag>
  fetchMarkupResult?: string
  captures?: Captures
  simulateVersionMiddleware?: boolean
}

const captureFindOptions = (options: unknown): CapturedFindOptions | undefined => {
  if (typeof options !== "object" || options === null) {
    return undefined
  }

  const limit = Reflect.get(options, "limit")
  const sort = Reflect.get(options, "sort")

  return { ...(typeof limit === "number" ? { limit } : {}), ...(sort !== undefined ? { sort } : {}) }
}

const buildLayer = (m: CardsMock) => {
  const spaces = m.spaces ?? []
  const cards = m.cards ?? []
  const masterTags = m.masterTags ?? []
  const cap = m.captures

  const findAllImpl: HulyClientOperations["findAll"] = ((_class: unknown, query: unknown, options: unknown) => {
    const q = query as Record<string, unknown>
    if (cap?.findAll) {
      cap.findAll.class = _class
      cap.findAll.query = q
      cap.findAll.options = captureFindOptions(options)
    }
    cap?.findAllCalls?.push({ class: _class, query: q })
    if (_class === cardPlugin.class.CardSpace) {
      return Effect.succeed(toFindResult(spaces.filter((space) => docMatches(space, q))))
    }
    if (_class === cardPlugin.class.MasterTag || _class === core.class.Class) {
      return Effect.succeed(toFindResult(masterTags.filter((tag) => docMatches(tag, q))))
    }
    if (_class === cardPlugin.class.Card) {
      const middlewareFiltered =
        m.simulateVersionMiddleware && q._id === undefined && q.baseId === undefined && q.isLatest === undefined
          ? cards.filter((card) => Reflect.get(card, "isLatest") === true)
          : cards
      return Effect.succeed(toFindResult(middlewareFiltered.filter((card) => docMatches(card, q))))
    }
    return Effect.succeed(toFindResult([]))
  }) as HulyClientOperations["findAll"]

  const findOneImpl: HulyClientOperations["findOne"] = ((_class: unknown, query: unknown) => {
    const q = query as Record<string, unknown>
    if (_class === cardPlugin.class.CardSpace) {
      return Effect.succeed(
        spaces.find((s) => (q.name !== undefined && s.name === q.name) || (q._id !== undefined && s._id === q._id))
      )
    }
    if (_class === cardPlugin.class.Card) {
      if (q.title !== undefined) return Effect.succeed(cards.find((c) => c.space === q.space && c.title === q.title))
      if (q._id !== undefined) return Effect.succeed(cards.find((c) => c.space === q.space && c._id === q._id))
      // lastCard lookup (space only, ordered by rank)
      return Effect.succeed(cards.find((c) => c.space === q.space))
    }
    return Effect.succeed(undefined)
  }) as HulyClientOperations["findOne"]

  const createDocImpl: HulyClientOperations["createDoc"] = ((
    _c: unknown,
    _s: unknown,
    attrs: unknown,
    id?: unknown
  ) => {
    if (cap?.createDoc) {
      cap.createDoc.class = _c
      cap.createDoc.space = _s
      cap.createDoc.attributes = attrs as Record<string, unknown>
      cap.createDoc.id = id
    }
    return Effect.succeed((id ?? "new-card-id") as Ref<Doc>)
  }) as HulyClientOperations["createDoc"]

  const updateDocImpl: HulyClientOperations["updateDoc"] = ((_c: unknown, _s: unknown, _id: unknown, ops: unknown) => {
    if (cap?.updateDoc) {
      cap.updateDoc.called = true
      cap.updateDoc.operations = ops as Record<string, unknown>
    }
    return Effect.succeed({} as never)
  }) as HulyClientOperations["updateDoc"]

  const removeDocImpl: HulyClientOperations["removeDoc"] = ((_c: unknown, _s: unknown, id: unknown) => {
    if (cap?.removeDoc) {
      cap.removeDoc.called = true
      cap.removeDoc.id = id
    }
    return Effect.succeed({} as never)
  }) as HulyClientOperations["removeDoc"]

  const uploadMarkupImpl: HulyClientOperations["uploadMarkup"] = ((
    _c: unknown,
    _id: unknown,
    _attr: unknown,
    markup: unknown
  ) => {
    if (cap?.uploadMarkup) {
      cap.uploadMarkup.called = true
      cap.uploadMarkup.value = markup as string
    }
    return Effect.succeed("markup-ref" as never)
  }) as HulyClientOperations["uploadMarkup"]

  const updateMarkupImpl: HulyClientOperations["updateMarkup"] = ((
    _c: unknown,
    _id: unknown,
    _attr: unknown,
    markup: unknown
  ) => {
    if (cap?.updateMarkup) {
      cap.updateMarkup.called = true
      cap.updateMarkup.value = markup as string
    }
    return Effect.succeed(undefined as never)
  }) as HulyClientOperations["updateMarkup"]

  const fetchMarkupImpl: HulyClientOperations["fetchMarkup"] = (() =>
    Effect.succeed(m.fetchMarkupResult ?? "rendered content")) as HulyClientOperations["fetchMarkup"]

  return HulyClient.testLayer({
    findAll: findAllImpl,
    findOne: findOneImpl,
    createDoc: createDocImpl,
    updateDoc: updateDocImpl,
    removeDoc: removeDocImpl,
    uploadMarkup: uploadMarkupImpl,
    updateMarkup: updateMarkupImpl,
    fetchMarkup: fetchMarkupImpl
  })
}

const SPACE = CardSpaceIdentifier.make("Cards")

describe("listCardSpaces", () => {
  it.effect("lists active spaces and maps blank descriptions to undefined", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      const result = yield* listCardSpaces({}).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace(), makeSpace({ _id: "space-2" as Ref<HulyCardSpace>, name: "Empty", description: "" })],
            captures
          })
        )
      )

      expect(result.total).toBe(2)
      expect(assertAt(result.cardSpaces, 0).name).toBe("Cards")
      expect(assertAt(result.cardSpaces, 0).description).toBe("Card space")
      expect(assertAt(result.cardSpaces, 0).types).toEqual(["tag-1"])
      expect(assertAt(result.cardSpaces, 1).description).toBeUndefined()
      // default excludes archived
      expect(captures.findAll?.query?.archived).toBe(false)
    })
  )

  it.effect("includes archived spaces when requested", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCardSpaces({ includeArchived: true }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], captures }))
      )

      expect(captures.findAll?.query).toEqual({})
    })
  )
})

describe("listMasterTags", () => {
  it.effect("fails when the card space is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        listMasterTags({ cardSpace: SPACE }).pipe(Effect.provide(buildLayer({ spaces: [] })))
      )
      expect(err._tag).toBe("CardSpaceNotFoundError")
    })
  )

  it.effect("returns empty when the space has no types", () =>
    Effect.gen(function* () {
      const result = yield* listMasterTags({ cardSpace: SPACE }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace({ types: [] })] }))
      )
      expect(result).toEqual({ masterTags: [], total: 0 })
    })
  )

  it.effect("maps master tags for a space", () =>
    Effect.gen(function* () {
      const result = yield* listMasterTags({ cardSpace: SPACE }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()] }))
      )
      expect(result.total).toBe(1)
      expect(assertAt(result.masterTags, 0)).toEqual({ id: "tag-1", name: "Document" })
    })
  )

  it.effect("includes master tags derived from the space's top-level types", () =>
    Effect.gen(function* () {
      const result = yield* listMasterTags({ cardSpace: SPACE }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            masterTags: [makeTag(), makeTag({ _id: CHILD_TAG_ID, label: tagLabel("Character"), extends: TAG_ID })]
          })
        )
      )

      expect(result.masterTags).toContainEqual({ id: "tag-child-1", name: "Character" })
      expect(result.total).toBe(2)
    })
  )

  it.effect("falls back to the raw master tag label when the display label is empty", () =>
    Effect.gen(function* () {
      const result = yield* listMasterTags({ cardSpace: SPACE }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag({ label: tagLabel("") })] }))
      )

      expect(assertAt(result.masterTags, 0)).toEqual({ id: "tag-1", name: "" })
    })
  )

  it.effect("excludes classes outside the space type ancestry", () =>
    Effect.gen(function* () {
      const cycleA = "cycle-a" as Ref<HulyMasterTag>
      const cycleB = "cycle-b" as Ref<HulyMasterTag>
      const result = yield* listMasterTags({ cardSpace: SPACE }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            masterTags: [
              makeTag(),
              makeTag({ _id: OTHER_TAG_ID, label: tagLabel("Other"), extends: cardPlugin.class.Card }),
              makeTag({
                _id: "missing-parent" as Ref<HulyMasterTag>,
                label: tagLabel("Missing"),
                extends: "missing" as never
              }),
              makeTag({ _id: cycleA, label: tagLabel("Cycle A"), extends: cycleB }),
              makeTag({ _id: cycleB, label: tagLabel("Cycle B"), extends: cycleA })
            ]
          })
        )
      )

      expect(result.masterTags).toEqual([{ id: "tag-1", name: "Document" }])
    })
  )
})

describe("listCards", () => {
  it.effect("fails when the card space is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(listCards({ cardSpace: SPACE }).pipe(Effect.provide(buildLayer({ spaces: [] }))))
      expect(err._tag).toBe("CardSpaceNotFoundError")
    })
  )

  it.effect("lists cards in a space (no filters)", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      const result = yield* listCards({ cardSpace: SPACE }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard()], captures }))
      )
      expect(result.total).toBe(1)
      expect(assertAt(result.cards, 0)).toEqual({ id: "card-1", title: "Roadmap", type: "tag-1", modifiedOn: 200 })
      // only the space filter is present
      expect(captures.findAll?.query).toEqual({ space: SPACE_ID })
    })
  )

  it.effect("applies a master tag type filter", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, type: MasterTagIdentifier.make("Document") }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], cards: [makeCard()], captures }))
      )
      expect(captures.findAll?.query?._class).toBe(TAG_ID)
    })
  )

  it.effect("fails when the type filter does not match a master tag", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        listCards({ cardSpace: SPACE, type: MasterTagIdentifier.make("Missing") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()] }))
        )
      )
      expect(err._tag).toBe("MasterTagNotFoundError")
    })
  )

  it.effect("fails the type filter when the space has no master tags at all", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        listCards({ cardSpace: SPACE, type: MasterTagIdentifier.make("Document") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace({ types: [] })] }))
        )
      )
      expect(err._tag).toBe("MasterTagNotFoundError")
    })
  )

  it.effect("resolves the type filter by master tag id", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, type: MasterTagIdentifier.make("tag-1") }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], cards: [makeCard()], captures }))
      )
      expect(captures.findAll?.query?._class).toBe(TAG_ID)
    })
  )

  it.effect("resolves the type filter by a derived master tag label", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, type: MasterTagIdentifier.make("Character") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            masterTags: [makeTag(), makeTag({ _id: CHILD_TAG_ID, label: tagLabel("Character"), extends: TAG_ID })],
            cards: [makeCard({ _class: CHILD_TAG_ID })],
            captures
          })
        )
      )
      expect(captures.findAll?.query?._class).toBe(CHILD_TAG_ID)
    })
  )

  it.effect("applies a titleSearch (LIKE) filter, escaping wildcards", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, titleSearch: "Road" }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], captures }))
      )
      expect(captures.findAll?.query?.title).toEqual({ $like: "%Road%" })
    })
  )

  it.effect("ignores a whitespace-only titleSearch", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, titleSearch: "   " }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], captures }))
      )
      expect(captures.findAll?.query?.title).toBeUndefined()
    })
  )

  it.effect("applies a titleRegex filter", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, titleRegex: "TODO%" }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], captures }))
      )
      expect(captures.findAll?.query?.title).toEqual({ $regex: "TODO%" })
    })
  )

  it.effect("applies a contentSearch (fulltext) filter", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAll: {} }
      yield* listCards({ cardSpace: SPACE, contentSearch: "design" }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], captures }))
      )
      expect(captures.findAll?.query?.$search).toBe("design")
    })
  )
})

describe("getCard", () => {
  it.effect("returns card detail with rendered content", () =>
    Effect.gen(function* () {
      const result = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [makeCard({ parent: "parent-1" as Ref<HulyCard>, children: 2 })],
            fetchMarkupResult: "# Roadmap"
          })
        ),
        withDiagnostics
      )
      expect(result.id).toBe("card-1")
      expect(result.title).toBe("Roadmap")
      expect(result.content).toBe("# Roadmap")
      expect(result.parent).toBe("parent-1")
      expect(result.children).toBe(2)
      expect(result.cardSpace).toBe("Cards")
      expect(result).not.toHaveProperty("properties")
    })
  )

  it.effect("omits content when the card has no content blob", () =>
    Effect.gen(function* () {
      const result = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "" as never, parent: null })] })
        ),
        withDiagnostics
      )
      expect(result.content).toBeUndefined()
      expect(result.parent).toBeUndefined()
    })
  )

  it.effect("exposes version metadata only when the runtime version state is coherent", () =>
    Effect.gen(function* () {
      const coherent = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [makeVersionableCard({ baseId: "chain-1" as Ref<Doc>, version: 2, isLatest: true, readonly: false })]
          })
        ),
        withDiagnostics
      )
      const partial = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Partial") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [
              makeVersionableCard({
                _id: "partial" as Ref<HulyCard>,
                title: "Partial",
                baseId: "chain-1" as Ref<Doc>,
                version: null,
                isLatest: null as never,
                readonly: null as never
              })
            ]
          })
        ),
        withDiagnostics
      )
      const optionalFlags = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Optional") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [
              makeVersionableCard({
                _id: "optional" as Ref<HulyCard>,
                title: "Optional",
                baseId: "chain-2" as Ref<Doc>,
                version: 1
              })
            ]
          })
        ),
        withDiagnostics
      )

      expect(coherent.version).toEqual({ number: 2, chainId: "chain-1", isLatest: true, readonly: false })
      expect(partial.version).toBeUndefined()
      expect(optionalFlags.version).toEqual({ number: 1, chainId: "chain-2" })
    })
  )

  it.effect("warns when incoherent version metadata is omitted", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const result = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Partial") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [
              makeVersionableCard({
                _id: "partial" as Ref<HulyCard>,
                title: "Partial",
                baseId: "chain-1" as Ref<Doc>,
                version: null
              })
            ]
          })
        ),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result.version).toBeUndefined()
      expect(warnings).toEqual([
        {
          code: "card_version_metadata_degraded",
          message:
            "Card 'partial' has degraded version metadata because these fields are absent or malformed: version. " +
            "Treat omitted version data as incomplete and inspect or repair the Huly card data."
        }
      ])
    })
  )

  it.effect("warns when malformed optional version fields are omitted from coherent core metadata", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const result = yield* getCard({ cardSpace: SPACE, card: CardIdentifier.make("Malformed flag") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [
              makeVersionableCard({
                _id: "malformed-flag" as Ref<HulyCard>,
                title: "Malformed flag",
                baseId: "chain-1" as Ref<Doc>,
                version: 2,
                isLatest: "yes" as never
              })
            ]
          })
        ),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result.version).toEqual({ number: 2, chainId: "chain-1" })
      expect(warnings).toEqual([
        {
          code: "card_version_metadata_degraded",
          message:
            "Card 'malformed-flag' has degraded version metadata because these fields are absent or malformed: " +
            "isLatest. Treat omitted version data as incomplete and inspect or repair the Huly card data."
        }
      ])
      expect(assertAt(warnings, 0).message).not.toContain("yes")
    })
  )

  it.effect("fails when the card is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        getCard({ cardSpace: SPACE, card: CardIdentifier.make("Ghost") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [] })),
          withDiagnostics
        )
      )
      expect(err._tag).toBe("CardNotFoundError")
    })
  )
})

describe("listCardVersions", () => {
  const versionCard = (
    id: string,
    number: number,
    overrides?: Partial<HulyCard> & RuntimeCardVersionFields
  ): HulyCard =>
    makeVersionableCard({
      _id: id as Ref<HulyCard>,
      title: `Roadmap v${number}`,
      baseId: "chain-1" as Ref<Doc>,
      version: number,
      isLatest: number === 3,
      readonly: number !== 3,
      createdOn: 100 + number,
      modifiedOn: 200 + number,
      ...overrides
    })

  it.effect("returns an unversioned card as a truthful singleton history", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const cardWithAbsentCreatedOn = { ...makeCard(), createdOn: undefined } as unknown as HulyCard
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap"), limit: 1 }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [cardWithAbsentCreatedOn] })),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result).toEqual({
        versions: [{ id: "card-1", title: "Roadmap", modifiedOn: 200 }],
        total: 1,
        hasMore: false
      })
      expect(warnings).toEqual([])
    })
  )

  it.effect("uses a recovered chain identity when the requested card has partial metadata", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const partial = versionCard("partial", 2, { version: null })
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("partial") }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: [versionCard("chain-1", 1), partial, versionCard("latest", 3)] })
        ),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result.versions.map((version) => version.id)).toEqual(["chain-1", "latest", "partial"])
      expect(result.total).toBe(3)
      expect(result.hasMore).toBe(false)
      expect(warnings).toEqual([
        {
          code: "card_version_metadata_degraded",
          message:
            "1 card version metadata field(s) were absent or malformed and omitted: partial.version. " +
            "Treat the affected version metadata and history ordering as degraded and inspect or repair the Huly card " +
            "data."
        }
      ])
    })
  )

  it.effect("uses recovered coherent metadata when an optional history field is malformed", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const malformedFlag = versionCard("malformed-flag", 2, { isLatest: "yes" as never })
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("malformed-flag") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [versionCard("chain-1", 1), malformedFlag, versionCard("latest", 3)]
          })
        ),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result.versions.map((version) => version.id)).toEqual(["chain-1", "malformed-flag", "latest"])
      expect(result.total).toBe(3)
      expect(warnings).toHaveLength(1)
      expect(assertAt(warnings, 0).message).toContain("malformed-flag.isLatest")
      expect(assertAt(warnings, 0).message).not.toContain("yes")
    })
  )

  it.effect("fails actionably when degraded metadata has no valid chain identity", () =>
    Effect.gen(function* () {
      const malformedChain = versionCard("malformed-chain", 2, { baseId: 42 as never })
      const error = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("malformed-chain") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [malformedChain] })),
          withDiagnostics
        )
      )

      expect(error).toBeInstanceOf(HulyError)
      expect(error.message).toContain("no valid version-chain identity")
      expect(error.message).toContain("baseId")
      expect(error.message).not.toContain("42")
    })
  )

  it.effect("fails with a typed integration error when a required card title is malformed", () =>
    Effect.gen(function* () {
      const malformed = malformedCardBoundaryFixture({ ...makeCard(), title: 42 })
      const error = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("card-1") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [malformed] })),
          withDiagnostics
        )
      )

      if (error._tag !== "HulyDataInvalidError") {
        return yield* Effect.die(new Error(`Expected HulyDataInvalidError, received ${error._tag}`))
      }
      expect(error.message).toContain("card version history")
    })
  )

  it.effect("distinguishes missing card spaces and ambiguous exact titles", () =>
    Effect.gen(function* () {
      const missingSpace = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
          Effect.provide(buildLayer({ spaces: [] })),
          withDiagnostics
        )
      )
      const ambiguousTitle = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
          Effect.provide(
            buildLayer({ spaces: [makeSpace()], cards: [makeCard(), makeCard({ _id: "card-2" as Ref<HulyCard> })] })
          ),
          withDiagnostics
        )
      )
      const missingCard = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Ghost") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [] })),
          withDiagnostics
        )
      )

      expect(missingSpace._tag).toBe("CardSpaceNotFoundError")
      expect(missingCard._tag).toBe("CardNotFoundError")
      expect(ambiguousTitle).toBeInstanceOf(HulyError)
      expect(ambiguousTitle.message).toContain("matches 2 version chains")
      expect(ambiguousTitle.message).toContain("use a card ID")
    })
  )

  it.effect("rejects mixed coherent and partial version chains sharing one exact title", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAllCalls: [] }
      const coherent = versionCard("chain-1", 1, { title: "Shared title" })
      const partial = makeVersionableCard({
        _id: "partial-card" as Ref<HulyCard>,
        title: "Shared title",
        baseId: "chain-2" as Ref<Doc>,
        version: null
      })
      const error = yield* Effect.flip(
        listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Shared title") }).pipe(
          Effect.provide(
            buildLayer({ spaces: [makeSpace()], cards: [coherent, partial], captures, simulateVersionMiddleware: true })
          ),
          withDiagnostics
        )
      )

      expect(error).toBeInstanceOf(HulyError)
      expect(error.message).toContain("matches 2 version chains")
      expect(captures.findAllCalls).toContainEqual({
        class: cardPlugin.class.Card,
        query: { space: SPACE_ID, title: "Shared title", _id: { $exists: true } }
      })
    })
  )

  it.effect("resolves an older version by ID while bypassing latest-only middleware filtering", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAllCalls: [] }
      const versions = [versionCard("chain-1", 1), versionCard("old-version", 2), versionCard("latest", 3)]
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("old-version") }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: versions, captures, simulateVersionMiddleware: true })
        ),
        withDiagnostics
      )

      expect(result.versions.map((version) => version.id)).toEqual(["chain-1", "old-version", "latest"])
      expect(result.total).toBe(3)
      expect(captures.findAllCalls).toContainEqual({
        class: cardPlugin.class.Card,
        query: { space: SPACE_ID, _id: "old-version" }
      })
      expect(captures.findAllCalls).toContainEqual({
        class: cardPlugin.class.Card,
        query: { space: SPACE_ID, baseId: "chain-1" }
      })
    })
  )

  it.effect("resolves an older version by exact title with an explicit all-version query", () =>
    Effect.gen(function* () {
      const captures: Captures = { findAllCalls: [] }
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap v2") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [versionCard("chain-1", 1), versionCard("old-version", 2), versionCard("latest", 3)],
            captures,
            simulateVersionMiddleware: true
          })
        ),
        withDiagnostics
      )

      expect(result.total).toBe(3)
      expect(captures.findAllCalls).toContainEqual({
        class: cardPlugin.class.Card,
        query: { space: SPACE_ID, title: "Roadmap v2", isLatest: { $in: [true, false] } }
      })
    })
  )

  it.effect("computes an authoritative total before applying the page limit", () =>
    Effect.gen(function* () {
      const cards = Array.from({ length: 51 }, (_, index) =>
        versionCard(index === 0 ? "chain-1" : `version-${index + 1}`, index + 1, {
          isLatest: index === 50,
          readonly: index !== 50
        })
      )
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("chain-1"), limit: 2 }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards })),
        withDiagnostics
      )

      expect(result.versions.map((version) => version.version?.number)).toEqual([1, 2])
      expect(result.total).toBe(51)
      expect(result.hasMore).toBe(true)
    })
  )

  it.effect("breaks equal-version ties by timestamps and then ID, with malformed metadata last", () =>
    Effect.gen(function* () {
      const diagnostics = yield* makeDiagnosticsScope
      const malformed = versionCard("malformed", 4, { version: null, createdOn: 1, modifiedOn: 1 })
      const missingCreatedA = {
        ...versionCard("missing-created-a", 4, { version: null, modifiedOn: 3 }),
        createdOn: undefined
      } as unknown as HulyCard
      const missingCreatedB = {
        ...versionCard("missing-created-b", 4, { version: null, modifiedOn: 2 }),
        createdOn: undefined
      } as unknown as HulyCard
      const invalidTimestamps = {
        ...versionCard("invalid-timestamps", 4, { version: null }),
        createdOn: -1,
        modifiedOn: 1.5
      } as unknown as HulyCard
      const result = yield* listCardVersions({ cardSpace: SPACE, card: CardIdentifier.make("chain-1") }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            cards: [
              missingCreatedA,
              missingCreatedB,
              invalidTimestamps,
              malformed,
              versionCard("chain-1", 1),
              versionCard("z", 2, { createdOn: 8, modifiedOn: 3 }),
              versionCard("b", 2, { createdOn: 7, modifiedOn: 5 }),
              versionCard("a", 2, { createdOn: 7, modifiedOn: 5 }),
              versionCard("c", 2, { createdOn: 7, modifiedOn: 4 }),
              versionCard("trailing-malformed", 4, { version: null, createdOn: 2, modifiedOn: 2 })
            ]
          })
        ),
        Effect.provideService(Diagnostics, diagnostics.service)
      )
      const warnings = yield* diagnostics.drainWarnings

      expect(result.versions.map((version) => version.id)).toEqual([
        "chain-1",
        "c",
        "a",
        "b",
        "z",
        "malformed",
        "trailing-malformed",
        "missing-created-b",
        "missing-created-a",
        "invalid-timestamps"
      ])
      expect(result.versions.at(-1)?.version).toBeUndefined()
      expect(result.versions.at(-1)?.createdOn).toBeUndefined()
      expect(result.versions.at(-1)?.modifiedOn).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(assertAt(warnings, 0)).toEqual({
        code: "card_version_metadata_degraded",
        message:
          "7 card version metadata field(s) were absent or malformed and omitted: malformed.version, " +
          "trailing-malformed.version, missing-created-b.version, missing-created-a.version, " +
          "invalid-timestamps.version, invalid-timestamps.modifiedOn, invalid-timestamps.createdOn. " +
          "Treat the affected version metadata and history ordering as degraded and inspect or repair the Huly card " +
          "data."
      })
    })
  )
})

describe("createCard", () => {
  it.effect("fails when the master tag type is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        createCard({ cardSpace: SPACE, type: MasterTagIdentifier.make("Missing"), title: "New card" }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()] }))
        )
      )
      expect(err._tag).toBe("MasterTagNotFoundError")
    })
  )

  it.effect("creates a top-level card (no parent)", () =>
    Effect.gen(function* () {
      const captures: Captures = { createDoc: {}, uploadMarkup: {} }
      const result = yield* createCard({
        cardSpace: SPACE,
        type: MasterTagIdentifier.make("Document"),
        title: "New card",
        content: "hello"
      }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], captures })))

      expect(result.title).toBe("New card")
      expect(typeof result.id).toBe("string")
      expect(captures.createDoc?.class).toBe(TAG_ID)
      expect(captures.createDoc?.space).toBe(SPACE_ID)
      expect(captures.createDoc?.attributes?.title).toBe("New card")
      expect(captures.createDoc?.attributes?.parent).toBeNull()
      expect(captures.createDoc?.attributes?.parentInfo).toEqual([])
      expect(capturedMarkupChildNodes(captures.uploadMarkup?.value)).toContainEqual({
        type: "text",
        text: "hello",
        marks: []
      })
    })
  )

  it.effect("creates card content with native references", () =>
    Effect.gen(function* () {
      const captures: Captures = { createDoc: {}, uploadMarkup: {} }
      yield* createCard({
        cardSpace: SPACE,
        type: MasterTagIdentifier.make("Document"),
        title: "Native ref card",
        content:
          "See [HULY-1](https://test.invalid/browse?workspace=test&_class=tracker%3Aclass%3AIssue&_id=issue-1&label=HULY-1)."
      }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], captures })))

      expect(capturedMarkupReferenceNodes(captures.uploadMarkup?.value)[0]).toMatchObject({
        type: "reference",
        attrs: { id: "issue-1", objectclass: "tracker:class:Issue", label: "HULY-1" }
      })
      expect(captures.createDoc?.attributes?.content).toBe("markup-ref")
    })
  )

  it.effect("creates a card using a derived master tag id", () =>
    Effect.gen(function* () {
      const captures: Captures = { createDoc: {}, uploadMarkup: {} }
      yield* createCard({
        cardSpace: SPACE,
        type: MasterTagIdentifier.make("tag-child-1"),
        title: "New character"
      }).pipe(
        Effect.provide(
          buildLayer({
            spaces: [makeSpace()],
            masterTags: [makeTag(), makeTag({ _id: CHILD_TAG_ID, label: tagLabel("Character"), extends: TAG_ID })],
            captures
          })
        )
      )

      expect(captures.createDoc?.class).toBe(CHILD_TAG_ID)
      expect(capturedMarkupChildNodes(captures.uploadMarkup?.value)).toEqual([])
    })
  )

  it.effect("creates a child card under a parent, threading parentInfo", () =>
    Effect.gen(function* () {
      const captures: Captures = { createDoc: {} }
      const parent = makeCard({ _id: "parent-1" as Ref<HulyCard>, title: "Parent", parentInfo: [] })
      yield* createCard({
        cardSpace: SPACE,
        type: MasterTagIdentifier.make("Document"),
        title: "Child",
        parent: CardIdentifier.make("Parent")
      }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], cards: [parent], captures })))

      expect(captures.createDoc?.attributes?.parent).toBe("parent-1")
      expect(captures.createDoc?.attributes?.parentInfo).toEqual([{ _id: "parent-1", _class: TAG_ID, title: "Parent" }])
    })
  )

  it.effect("reports the resolved card-space name when a parent is missing for a space ID locator", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        createCard({
          cardSpace: CardSpaceIdentifier.make("space-1"),
          type: MasterTagIdentifier.make("Document"),
          title: "Child",
          parent: CardIdentifier.make("Ghost parent")
        }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace()], masterTags: [makeTag()], cards: [] })))
      )
      expect(err).toEqual(
        new CardNotFoundError({
          identifier: CardIdentifier.make("Ghost parent"),
          cardSpace: CardSpaceIdentifier.make("Cards")
        })
      )
      expect(err.message).toBe("Card 'Ghost parent' not found in card space 'Cards'")
    })
  )

  it.effect("returns a typed boundary error when the resolved card-space name is invalid", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        createCard({
          cardSpace: CardSpaceIdentifier.make("space-1"),
          type: MasterTagIdentifier.make("Document"),
          title: "Child",
          parent: CardIdentifier.make("Ghost parent")
        }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace({ name: "" })], masterTags: [makeTag()], cards: [] })))
      )
      expect(err).toBeInstanceOf(HulyError)
      expect(err.message).toBe("Resolved card space has an invalid name")
    })
  )
})

describe("updateCard", () => {
  it.effect("fails when no update fields are provided", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
          Effect.provide(HulyClient.testLayer({}))
        )
      )

      expect(err._tag).toBe("NoUpdateFieldsError")
    })
  )

  it.effect("updates the title via updateDoc", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {} }
      const result = yield* updateCard({
        cardSpace: SPACE,
        card: CardIdentifier.make("Roadmap"),
        title: "Renamed"
      }).pipe(Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard()], captures })))

      expect(result).toEqual({ id: "card-1", updated: true })
      expect(captures.updateDoc?.operations).toEqual({ title: "Renamed" })
    })
  )

  it.effect("updates existing content in place via updateMarkup (no updateDoc)", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }
      yield* updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap"), content: "new body" }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "existing" as never })], captures })
        )
      )

      expect(capturedMarkupChildNodes(captures.updateMarkup?.value)).toContainEqual({
        type: "text",
        text: "new body",
        marks: []
      })
      expect(captures.uploadMarkup?.called).toBeUndefined()
      // content edits go through updateMarkup, leaving no DocumentUpdate ops
      expect(captures.updateDoc?.called).toBeUndefined()
    })
  )

  it.effect("updates existing card content with native references", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }
      yield* updateCard({
        cardSpace: SPACE,
        card: CardIdentifier.make("Roadmap"),
        content:
          "See [HULY-1](https://test.invalid/browse?workspace=test&_class=tracker%3Aclass%3AIssue&_id=issue-1&label=HULY-1)."
      }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "existing" as never })], captures })
        )
      )

      expect(capturedMarkupReferenceNodes(captures.updateMarkup?.value)[0]).toMatchObject({
        type: "reference",
        attrs: { id: "issue-1", objectclass: "tracker:class:Issue", label: "HULY-1" }
      })
      expect(captures.uploadMarkup?.called).toBeUndefined()
      expect(captures.updateDoc?.called).toBeUndefined()
    })
  )

  it.effect("clears existing content in place when content is null", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }

      yield* updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap"), content: null }).pipe(
        Effect.provide(
          buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "existing" as never })], captures })
        )
      )

      expect(capturedMarkupChildNodes(captures.updateMarkup?.value)).toEqual([])
      expect(captures.uploadMarkup?.called).toBeUndefined()
      expect(captures.updateDoc?.called).toBeUndefined()
    })
  )

  it.effect("uploads content when the card had no content blob", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }
      yield* updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap"), content: "first body" }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "" as never })], captures }))
      )

      expect(capturedMarkupChildNodes(captures.uploadMarkup?.value)).toContainEqual({
        type: "text",
        text: "first body",
        marks: []
      })
      expect(captures.updateMarkup?.called).toBeUndefined()
      expect(captures.updateDoc?.operations).toEqual({ content: "markup-ref" })
    })
  )

  it.effect("uploads new card content with native references when no blob exists", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }
      yield* updateCard({
        cardSpace: SPACE,
        card: CardIdentifier.make("Roadmap"),
        content:
          "See [HULY-1](https://test.invalid/browse?workspace=test&_class=tracker%3Aclass%3AIssue&_id=issue-1&label=HULY-1)."
      }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "" as never })], captures }))
      )

      expect(capturedMarkupReferenceNodes(captures.uploadMarkup?.value)[0]).toMatchObject({
        type: "reference",
        attrs: { id: "issue-1", objectclass: "tracker:class:Issue", label: "HULY-1" }
      })
      expect(captures.updateMarkup?.called).toBeUndefined()
      expect(captures.updateDoc?.operations).toEqual({ content: "markup-ref" })
    })
  )

  it.effect("uploads empty content when a card without content is cleared with null", () =>
    Effect.gen(function* () {
      const captures: Captures = { updateDoc: {}, updateMarkup: {}, uploadMarkup: {} }

      yield* updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap"), content: null }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard({ content: "" as never })], captures }))
      )

      expect(capturedMarkupChildNodes(captures.uploadMarkup?.value)).toEqual([])
      expect(captures.updateMarkup?.called).toBeUndefined()
      expect(captures.updateDoc?.operations).toEqual({ content: "markup-ref" })
    })
  )

  it.effect("fails when the card is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        updateCard({ cardSpace: SPACE, card: CardIdentifier.make("Ghost"), title: "x" }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [] }))
        )
      )
      expect(err._tag).toBe("CardNotFoundError")
    })
  )
})

describe("deleteCard", () => {
  it.effect("removes the card", () =>
    Effect.gen(function* () {
      const captures: Captures = { removeDoc: {} }
      const result = yield* deleteCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
        Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [makeCard()], captures }))
      )
      expect(result).toEqual({ id: "card-1", deleted: true })
      expect(captures.removeDoc?.called).toBe(true)
      expect(captures.removeDoc?.id).toBe("card-1")
    })
  )

  it.effect("fails when the card is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        deleteCard({ cardSpace: SPACE, card: CardIdentifier.make("Ghost") }).pipe(
          Effect.provide(buildLayer({ spaces: [makeSpace()], cards: [] }))
        )
      )
      expect(err._tag).toBe("CardNotFoundError")
    })
  )

  it.effect("fails when the card space is not found", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        deleteCard({ cardSpace: SPACE, card: CardIdentifier.make("Roadmap") }).pipe(
          Effect.provide(buildLayer({ spaces: [] }))
        )
      )
      expect(err._tag).toBe("CardSpaceNotFoundError")
    })
  )
})
