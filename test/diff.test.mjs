/**
 * Diff assembly: the synthesized new-file diff, the truncation cap, and the
 * reader's table of contents.
 *
 * This is the module whose output is the *only* record of a discarded change —
 * `git restore` has already destroyed the original by the time anyone reads the
 * archive — so it is pinned line by line rather than spot-checked.
 *
 * @module dsh-gitbar-lite/test/diff
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  countContentLines,
  diffTotals,
  joinDiffParts,
  limitDiff,
  looksBinary,
  modeTextFor,
  splitDiffByFile,
  synthesizeNewFileDiff,
} from '../lib/host/diff.js'

describe('synthesizeNewFileDiff', () => {
  it('shapes a text file exactly like git would, hunks and all', () => {
    const text = synthesizeNewFileDiff({ path: 'notes.txt', content: 'alpha\nbeta\n', mode: '100644' })
    assert.equal(
      text,
      [
        'diff --git a/notes.txt b/notes.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/notes.txt',
        '@@ -0,0 +1,2 @@',
        '+alpha',
        '+beta',
        '',
      ].join('\n'),
    )
  })

  it('marks a file that does not end in a newline, the way git does', () => {
    const text = synthesizeNewFileDiff({ path: 'x.txt', content: 'no newline here', mode: '100644' })
    assert.ok(text.includes('@@ -0,0 +1,1 @@'), text)
    assert.ok(text.includes('+no newline here'), text)
    assert.ok(text.includes('\\ No newline at end of file'), text)
    assert.ok(text.endsWith('\n'), 'the synthesized diff itself still ends in a newline')
  })

  it('carries the executable bit through the mode line', () => {
    assert.ok(synthesizeNewFileDiff({ path: 'run.sh', content: 'x\n', mode: '100755' }).includes('new file mode 100755'))
  })

  it('emits no hunk for an empty file', () => {
    const text = synthesizeNewFileDiff({ path: 'empty.txt', content: '', mode: '100644' })
    assert.ok(text.includes('new file mode 100644'), text)
    assert.ok(!text.includes('@@'), text)
  })

  it('says "binary" rather than pretending to hold the bytes', () => {
    const text = synthesizeNewFileDiff({ path: 'blob.bin', content: '', binary: true, mode: '100644' })
    assert.ok(text.includes('Binary files /dev/null and b/blob.bin differ'), text)
    assert.ok(!text.includes('@@'), text)
  })

  it('strips a trailing CR so a CRLF worktree file reads like its neighbours', () => {
    const text = synthesizeNewFileDiff({ path: 'crlf.txt', content: 'one\r\ntwo\r\n', mode: '100644' })
    assert.ok(text.includes('+one\n'), text)
    assert.ok(!text.includes('\r'), text)
  })

  it('does not confuse a lone CR inside a line with a line ending', () => {
    const text = synthesizeNewFileDiff({ path: 'odd.txt', content: 'a\rb\n', mode: '100644' })
    assert.ok(text.includes('+a\rb'), text)
  })
})

describe('countContentLines', () => {
  it('counts logical lines the way a diff would', () => {
    assert.equal(countContentLines(''), 0)
    assert.equal(countContentLines('one\n'), 1)
    assert.equal(countContentLines('one\ntwo\n'), 2)
    assert.equal(countContentLines('one\ntwo'), 2)
  })
})

describe('looksBinary', () => {
  it('uses the NUL-byte heuristic', () => {
    assert.equal(looksBinary(Buffer.from('plain text\n')), false)
    assert.equal(looksBinary(Buffer.from([1, 2, 0, 3])), true)
    assert.equal(looksBinary(Buffer.alloc(0)), false)
  })

  it('only sniffs the first 8000 bytes', () => {
    const late = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0])])
    assert.equal(looksBinary(late), false)
  })
})

describe('modeTextFor', () => {
  it('maps the executable bit to the git mode text', () => {
    assert.equal(modeTextFor({ mode: 0o100644 }), '100644')
    assert.equal(modeTextFor({ mode: 0o100755 }), '100755')
    assert.equal(modeTextFor({}), '100644')
    assert.equal(modeTextFor(undefined), '100644')
  })
})

describe('limitDiff', () => {
  it('returns the text untouched when it fits', () => {
    const text = 'a\nb\nc\n'
    const limited = limitDiff(text, 1024)
    assert.equal(limited.text, text)
    assert.equal(limited.truncated, false)
    assert.equal(limited.droppedLines, 0)
  })

  it('cuts on a line boundary and says how much it dropped', () => {
    const text = ['+one', '+two', '+three', '+four', '+five'].join('\n')
    const limited = limitDiff(text, 20)
    assert.equal(limited.truncated, true)
    assert.ok(limited.droppedLines > 0, limited)
    assert.ok(Buffer.byteLength(limited.text, 'utf8') > 20, 'the marker is allowed past the cap')
    assert.ok(limited.text.includes('[dsh-gitbar-lite] diff truncated'), limited.text)
    // No line is ever half-kept.
    for (const line of limited.text.split('\n')) {
      if (line.startsWith('+')) assert.ok(text.includes(line), `partial line kept: ${JSON.stringify(line)}`)
    }
  })

  it('never cuts a multi-byte character in half', () => {
    const text = '中文内容\n'.repeat(40)
    const limited = limitDiff(text, 60)
    assert.equal(limited.truncated, true)
    assert.ok(!limited.text.includes('\uFFFD'), 'a replacement character means a character was split')
  })

  it('treats a non-positive cap as "no cap"', () => {
    assert.equal(limitDiff('a\nb\n', 0).truncated, false)
    assert.equal(limitDiff('a\nb\n', Number.NaN).truncated, false)
  })
})

describe('splitDiffByFile', () => {
  const twoFiles = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/sub/b.txt b/sub/b.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/sub/b.txt',
    '@@ -0,0 +1 @@',
    '+fresh',
    '',
  ].join('\n')

  it('splits one blob into one block per file, pathed from the +++ line', () => {
    const blocks = splitDiffByFile(twoFiles)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].path, 'a.txt')
    assert.equal(blocks[1].path, 'sub/b.txt')
    assert.ok(blocks[0].text.startsWith('diff --git a/a.txt'))
    assert.ok(blocks[1].text.includes('+fresh'))
  })

  it('prefers the rename target when a block is a pure rename', () => {
    const blocks = splitDiffByFile(
      [
        'diff --git a/sub dir/b.txt b/renamed dir/b.txt',
        'similarity index 100%',
        'rename from sub dir/b.txt',
        'rename to renamed dir/b.txt',
        '',
      ].join('\n'),
    )
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].path, 'renamed dir/b.txt')
  })

  it('falls back to the --- line when a file was deleted', () => {
    const blocks = splitDiffByFile(
      ['diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '-bye', ''].join('\n'),
    )
    assert.equal(blocks[0].path, 'gone.txt')
  })

  it('handles a diff with no file blocks, and an empty one', () => {
    assert.deepEqual(splitDiffByFile(''), [])
    assert.deepEqual(splitDiffByFile('not a diff\n'), [])
  })
})

describe('diffTotals', () => {
  it('counts +/- lines inside hunks only', () => {
    const totals = diffTotals(
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,3 @@',
        ' context',
        '-removed',
        '+added one',
        '+added two',
        'diff --git a/b.txt b/b.txt',
        '@@ -1 +0,0 @@',
        '-another',
        '',
      ].join('\n'),
    )
    assert.deepEqual(totals, { added: 2, deleted: 2 })
  })

  it('does not count the +++/--- file headers as content', () => {
    assert.deepEqual(diffTotals(['--- a/a.txt', '+++ b/a.txt'].join('\n')), { added: 0, deleted: 0 })
  })
})

describe('joinDiffParts', () => {
  it('concatenates blocks and guarantees exactly one trailing newline each', () => {
    assert.equal(joinDiffParts([{ text: 'one\n' }, { text: 'two' }]), 'one\ntwo\n')
  })

  it('is the identity for a single block', () => {
    assert.equal(joinDiffParts([{ text: 'x\n' }]), 'x\n')
  })
})
