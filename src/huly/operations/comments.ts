import type { ChatMessage } from "@hcengineering/chunter"
import { type AttachedData, type DocumentUpdate, generateId, type Ref, SortingOrder } from "@hcengineering/core"
import { Clock, Effect, Schema } from "effect"

import type {
  AddCommentParams,
  Comment,
  DeleteCommentParams,
  ListCommentsParams,
  UpdateCommentParams
} from "../../domain/schemas.js"
import { CommentSchema } from "../../domain/schemas/comments.js"
import type { AddCommentResult, DeleteCommentResult, UpdateCommentResult } from "../../domain/schemas/comments.js"
import { CommentId, IssueIdentifier } from "../../domain/schemas/shared.js"
import type { HulyClient, HulyClientError } from "../client.js"
import type { IssueNotFoundError, ProjectNotFoundError } from "../errors.js"
import { CommentNotFoundError, HulyDataInvalidError } from "../errors.js"
import { findProjectAndIssue as findProjectAndIssueShared } from "./issues-shared.js"
import { clampLimit } from "./query-helpers.js"
import { toRef } from "./sdk-boundary.js"

import { chunter, tracker } from "../huly-plugins.js"
import { markdownToMarkupString, optionalMarkupToMarkdown } from "./markup.js"

type ListCommentsError = HulyClientError | HulyDataInvalidError | ProjectNotFoundError | IssueNotFoundError

type AddCommentError = HulyClientError | ProjectNotFoundError | IssueNotFoundError

type UpdateCommentError = HulyClientError | ProjectNotFoundError | IssueNotFoundError | CommentNotFoundError

type DeleteCommentError = HulyClientError | ProjectNotFoundError | IssueNotFoundError | CommentNotFoundError
const parseComments = Schema.decodeUnknownEffect(Schema.Array(CommentSchema))

// --- Helpers ---

const findProjectAndIssue = (params: { project: string; issueIdentifier: string }) =>
  findProjectAndIssueShared({ project: params.project, identifier: params.issueIdentifier })

const findComment = (params: { project: string; issueIdentifier: string; commentId: string }) =>
  Effect.gen(function* () {
    const { client, issue, project } = yield* findProjectAndIssue({
      project: params.project,
      issueIdentifier: params.issueIdentifier
    })

    const comment = yield* client.findOne<ChatMessage>(chunter.class.ChatMessage, {
      _id: toRef<ChatMessage>(params.commentId),
      attachedTo: issue._id
    })

    if (comment === undefined) {
      return yield* new CommentNotFoundError({
        commentId: params.commentId,
        issueIdentifier: params.issueIdentifier,
        project: params.project
      })
    }

    return { client, issue, project, comment }
  })

// --- Operations ---

/**
 * List comments on an issue.
 * Results sorted by createdOn ascending (oldest first).
 */
export const listComments = (
  params: ListCommentsParams
): Effect.Effect<Array<Comment>, ListCommentsError, HulyClient> =>
  Effect.gen(function* () {
    const { client, issue } = yield* findProjectAndIssue({
      project: params.project,
      issueIdentifier: params.issueIdentifier
    })
    const markupUrlConfig = client.markupUrlConfig

    const limit = clampLimit(params.limit)

    const messages = yield* client.findAll<ChatMessage>(
      chunter.class.ChatMessage,
      { attachedTo: issue._id, attachedToClass: tracker.class.Issue },
      { limit, sort: { createdOn: SortingOrder.Ascending } }
    )

    // Schema decoding returns a readonly array; the Huly operation contract requires a mutable array.
    const comments = yield* Effect.forEach(messages, (msg) =>
      optionalMarkupToMarkdown(msg.message, markupUrlConfig, "", {
        operation: "listComments",
        entity: "comment body"
      }).pipe(
        Effect.map((body) => ({
          id: msg._id,
          body,
          authorId: msg.modifiedBy,
          createdOn: msg.createdOn,
          modifiedOn: msg.modifiedOn,
          editedOn: msg.editedOn
        }))
      )
    )
    const validated = yield* parseComments(comments).pipe(
      Effect.mapError(
        (parseError) => new HulyDataInvalidError({ operation: "listComments", entity: "comment", cause: parseError })
      )
    )

    return [...validated]
  })

/**
 * Add a comment to an issue.
 */
export const addComment = (params: AddCommentParams): Effect.Effect<AddCommentResult, AddCommentError, HulyClient> =>
  Effect.gen(function* () {
    const { client, issue, project } = yield* findProjectAndIssue({
      project: params.project,
      issueIdentifier: params.issueIdentifier
    })
    const markupUrlConfig = client.markupUrlConfig

    const commentId: Ref<ChatMessage> = generateId()

    const commentData: AttachedData<ChatMessage> = { message: markdownToMarkupString(params.body, markupUrlConfig) }

    yield* client.addCollection(
      chunter.class.ChatMessage,
      project._id,
      issue._id,
      tracker.class.Issue,
      "comments",
      commentData,
      commentId
    )

    // Verify by reading back
    const written = yield* client.findOne(chunter.class.ChatMessage, { _id: commentId })
    if (written === undefined) {
      return yield* new HulyConnectionError({
        message:
          "add_comment failed silently: The backend accepted the operation but the comment was not written. Verify you have write permissions for this project."
      })
    }

    return { commentId: CommentId.make(commentId), issueIdentifier: IssueIdentifier.make(issue.identifier) }
  })

/**
 * Update an existing comment on an issue.
 */
export const updateComment = (
  params: UpdateCommentParams
): Effect.Effect<UpdateCommentResult, UpdateCommentError, HulyClient> =>
  Effect.gen(function* () {
    const { client, comment, issue, project } = yield* findComment(params)
    const markupUrlConfig = client.markupUrlConfig

    const newMarkup = markdownToMarkupString(params.body, markupUrlConfig)

    if (newMarkup === comment.message) {
      return {
        commentId: CommentId.make(params.commentId),
        issueIdentifier: IssueIdentifier.make(issue.identifier),
        updated: false
      }
    }

    const now = yield* Clock.currentTimeMillis
    const updateOps: DocumentUpdate<ChatMessage> = { message: newMarkup, editedOn: now }

    yield* client.updateDoc(chunter.class.ChatMessage, project._id, comment._id, updateOps)

    return {
      commentId: CommentId.make(params.commentId),
      issueIdentifier: IssueIdentifier.make(issue.identifier),
      updated: true
    }
  })

/**
 * Delete a comment from an issue.
 */
export const deleteComment = (
  params: DeleteCommentParams
): Effect.Effect<DeleteCommentResult, DeleteCommentError, HulyClient> =>
  Effect.gen(function* () {
    const { client, comment, issue, project } = yield* findComment(params)

    yield* client.removeDoc(chunter.class.ChatMessage, project._id, comment._id)

    return {
      commentId: CommentId.make(params.commentId),
      issueIdentifier: IssueIdentifier.make(issue.identifier),
      deleted: true
    }
  })
