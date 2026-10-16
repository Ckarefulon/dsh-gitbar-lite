/**
 * `git status --porcelain=v2 -z` and `--numstat -z` parsing.
 *
 * The fixtures are byte-for-byte the shapes real git emitted on this machine
 * (including a rename, a staged delete, a conflict, a non-ASCII path, and a
 * path with a space) — a hand-written approximation of a git format is how a
 * parser bug gets a green test.
 *
 * @module dsh-gitbar-lite/test/parse
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseNameOnly, parseNumstat, parseStatus } from '../lib/host/parse.js'

/** Join records the way `-z` does: NUL-terminated, paths raw. */
function z(...records) {
  return `${records.join('\0')}\0`
}

const HASH_A = '4cb29ea38f70d7c61b2a3a25b02e3bdf44905402'
const HASH_B = '6addb9b2c1b0e2b2c1b0e2b2c1b0e2b2c1b0e2b2'
const ZERO = '0000000000000000000000000000000000000000'

describe('parseStatus: branch header', () => {
  it('reads oid, head, upstream and the ahead/behind pair', () => {
    const { branch } = parseStatus(
      z('# branch.oid ' + HASH_A, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'),
    )
    assert.deepEqual(branch, {
      oid: HASH_A,
      head: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      detached: false,
      unborn: false,
    })
  })

  it('recognizes an unborn branch', () => {
    const { branch } = parseStatus(z('# branch.oid (initial)', '# branch.head main'))
    assert.equal(branch.unborn, true)
    assert.equal(branch.oid, '(initial)')
  })

  it('recognizes a detached head', () => {
    const { branch } = parseStatus(z('# branch.oid ' + HASH_A, '# branch.head (detached)'))
    assert.equal(branch.detached, true)
    assert.equal(branch.head, '(detached)')
  })

  it('leaves upstream null when there is none, with zero ahead/behind', () => {
    const { branch } = parseStatus(z('# branch.oid ' + HASH_A, '# branch.head main'))
    assert.equal(branch.upstream, null)
    assert.deepEqual([branch.ahead, branch.behind], [0, 0])
  })
})

describe('parseStatus: ordinary entries', () => {
  it('reads an unstaged modification', () => {
    const { files } = parseStatus(z(`1 .M N... 100644 100644 100644 ${HASH_A} ${HASH_B} a.txt`))
    assert.equal(files.length, 1)
    assert.deepEqual(
      { path: files[0].path, kind: files[0].kind, staged: files[0].staged, partial: files[0].partial },
      { path: 'a.txt', kind: 'modified', staged: false, partial: false },
    )
  })

  it('reads a fully staged modification as staged and not partial', () => {
    const { files } = parseStatus(z(`1 M. N... 100644 100644 100644 ${HASH_A} ${HASH_A} a.txt`))
    assert.equal(files[0].staged, true)
    assert.equal(files[0].partial, false)
  })

  it('reads a half-staged file as staged AND partial', () => {
    const { files } = parseStatus(z(`1 MM N... 100644 100644 100644 ${HASH_A} ${HASH_A} a.txt`))
    assert.equal(files[0].staged, true)
    assert.equal(files[0].partial, true)
  })

  it('reads an added file as added and staged', () => {
    const { files } = parseStatus(z(`1 A. N... 000000 100644 100644 ${ZERO} ${HASH_A} added.txt`))
    assert.equal(files[0].kind, 'added')
    assert.equal(files[0].staged, true)
  })

  it('distinguishes a staged delete from an unstaged one', () => {
    const staged = parseStatus(z(`1 D. N... 100644 000000 000000 ${HASH_A} ${ZERO} gone.txt`))
    const unstaged = parseStatus(z(`1 .D N... 100644 100644 000000 ${HASH_A} ${HASH_A} gone.txt`))
    assert.equal(staged.files[0].kind, 'deleted')
    assert.equal(staged.files[0].staged, true)
    assert.equal(unstaged.files[0].kind, 'deleted')
    assert.equal(unstaged.files[0].staged, false)
  })

  it('reads a typechange as a modification', () => {
    const { files } = parseStatus(z(`1 .T N... 100644 100644 120000 ${HASH_A} ${HASH_B} link`))
    assert.equal(files[0].kind, 'modified')
  })
})

describe('parseStatus: renames', () => {
  it('takes the new path from the record and the old path from the next field', () => {
    const { files } = parseStatus(
      z(`2 R. N... 100644 100644 100644 ${HASH_A} ${HASH_A} R100 renamed dir/b.txt`, 'sub dir/b.txt'),
    )
    assert.equal(files.length, 1)
    assert.equal(files[0].kind, 'renamed')
    assert.equal(files[0].path, 'renamed dir/b.txt')
    assert.equal(files[0].origPath, 'sub dir/b.txt')
    assert.equal(files[0].staged, true)
  })

  it('does not swallow the record after a rename', () => {
    const { files } = parseStatus(
      z(
        `2 R. N... 100644 100644 100644 ${HASH_A} ${HASH_A} R100 new.txt`,
        'old.txt',
        `1 .M N... 100644 100644 100644 ${HASH_A} ${HASH_B} other.txt`,
      ),
    )
    assert.deepEqual(
      files.map((file) => file.path),
      ['new.txt', 'other.txt'],
    )
  })
})

describe('parseStatus: conflicts', () => {
  it('reads an unmerged record and keeps a path that contains a space', () => {
    // The regression this pins: nine fixed fields follow the `u` tag, not ten.
    // Counting ten eats the first word of the path and yields an entry whose
    // path is empty — the file then simply disappears from the list.
    const { files } = parseStatus(
      z(`u UU N... 100644 100644 100644 100644 ${HASH_A} ${HASH_B} ${HASH_A} my file.txt`),
    )
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'my file.txt')
    assert.equal(files[0].kind, 'conflicted')
    assert.equal(files[0].conflicted, true)
  })

  it('treats an AA pair on an ordinary record as a conflict too', () => {
    const { files } = parseStatus(z(`1 AA N... 000000 000000 100644 ${ZERO} ${ZERO} both.txt`))
    assert.equal(files[0].kind, 'conflicted')
  })
})

describe('parseStatus: untracked, ignored, and odd paths', () => {
  it('reads untracked and ignored records', () => {
    const { files } = parseStatus(z('? untracked new.txt', '! ignored.txt'))
    assert.equal(files[0].untracked, true)
    assert.equal(files[0].staged, false)
    assert.equal(files[0].kind, 'untracked')
    assert.equal(files[1].ignored, true)
    assert.equal(files[1].staged, false)
  })

  it('keeps a non-ASCII path verbatim', () => {
    const { files } = parseStatus(z(`1 .M N... 100644 100644 100644 ${HASH_A} ${HASH_B} 中文 文件.txt`))
    assert.equal(files[0].path, '中文 文件.txt')
  })

  it('survives a path that contains NUL-adjacent oddities like a leading space', () => {
    const { files } = parseStatus(z(`1 .M N... 100644 100644 100644 ${HASH_A} ${HASH_B} leading space.txt`))
    assert.equal(files[0].path, 'leading space.txt')
  })

  it('handles an empty stream', () => {
    assert.deepEqual(parseStatus('').files, [])
    assert.equal(parseStatus('').branch.oid, null)
  })

  it('ignores a truncated record instead of inventing an entry', () => {
    assert.deepEqual(parseStatus(z(`1 .M N... 100644`)).files, [])
  })
})

describe('parseNumstat', () => {
  it('reads added/deleted counts keyed by path', () => {
    const map = parseNumstat(z('3\t1\ta.txt', '0\t2\tdocs/guide.md'))
    assert.deepEqual(map.get('a.txt'), { path: 'a.txt', added: 3, deleted: 1, binary: false })
    assert.deepEqual(map.get('docs/guide.md'), { path: 'docs/guide.md', added: 0, deleted: 2, binary: false })
  })

  it('reads a binary entry as a dash pair', () => {
    const map = parseNumstat(z('-\t-\tblob.bin'))
    assert.deepEqual(map.get('blob.bin'), { path: 'blob.bin', added: 0, deleted: 0, binary: true })
  })

  it('reads a rename entry, whose path field is empty and whose paths follow', () => {
    const map = parseNumstat(z('4\t0\t', 'old name.txt', 'new name.txt'))
    assert.deepEqual(map.get('new name.txt'), {
      path: 'new name.txt',
      origPath: 'old name.txt',
      added: 4,
      deleted: 0,
      binary: false,
    })
  })

  it('handles an empty stream', () => {
    assert.equal(parseNumstat('').size, 0)
  })
})

describe('parseNameOnly', () => {
  it('splits a NUL-separated path list', () => {
    assert.deepEqual(parseNameOnly(z('a.txt', 'b c.txt')), ['a.txt', 'b c.txt'])
  })
})
