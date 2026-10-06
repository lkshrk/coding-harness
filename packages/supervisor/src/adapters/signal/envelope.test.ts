import { describe, expect, test } from 'bun:test'
import {
  canonicalGroupId,
  type Frame,
  frameKind,
  groupOf,
  groupRecipient,
  parseFrame,
  textOf,
} from './envelope'
import { fixture, GROUP_RAW } from './testing'

const parsed = (name: string) => parseFrame(JSON.stringify(fixture(name))) as Frame

describe('frame kinds', () => {
  test('captured frames classify by payload, polls before plain data', () => {
    expect(frameKind(parsed('group_data_message').envelope)).toBe('data')
    expect(frameKind(parsed('typing_message').envelope)).toBe('typing')
    expect(frameKind(parsed('receipt_message').envelope)).toBe('receipt')
    expect(frameKind(parsed('poll_create').envelope)).toBe('pollCreate')
    expect(frameKind(parsed('poll_vote').envelope)).toBe('pollVote')
    expect(frameKind(parsed('group_quote_reply').envelope)).toBe('data')
  })

  test('poll frames carry no text; data frames carry text and their group', () => {
    expect(textOf(parsed('poll_vote').envelope)).toBe('')
    expect(textOf(parsed('group_data_message').envelope)).toBe('hello claude')
    expect(groupOf(parsed('group_data_message').envelope)).toBe(GROUP_RAW)
    expect(groupOf(parsed('typing_message').envelope)).toBeNull()
  })

  test('unparseable or envelope-less frames are dropped', () => {
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('{"jsonrpc":"2.0"}')).toBeNull()
  })
})

describe('group ids', () => {
  test('raw and group.<base64> forms canonicalise to the raw id', () => {
    const send = groupRecipient(GROUP_RAW)
    expect(send.startsWith('group.')).toBe(true)
    expect(groupRecipient(send)).toBe(send)
    expect(canonicalGroupId(send)).toBe(GROUP_RAW)
    expect(canonicalGroupId(GROUP_RAW)).toBe(GROUP_RAW)
    expect(canonicalGroupId('group.not base64!')).toBe('group.not base64!')
  })
})
