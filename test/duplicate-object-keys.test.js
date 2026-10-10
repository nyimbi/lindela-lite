#!/usr/bin/env node
/**
 * VER-11 — duplicate keys in one object literal.
 *
 * `src/calibration.js` declared `outcome_coverage` twice in the region literal.
 * The second won, so the first was dead code that looked live: a maintainer
 * editing it would have seen no effect and no error. Strict mode does not make
 * this an error — only duplicate *parameter* names are — so nothing at runtime
 * could have reported it, and a behavioural test cannot see a value that was
 * never used.
 *
 * The class, not just the instance: any key repeated inside one literal, in
 * `src/`. The scan strips comments and string bodies first, then brace-matches,
 * then reads keys at each literal's own depth. That keeps a key in a nested
 * object from colliding with its parent's, which is legal and common here.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files in the jurisdiction: shipped source, not the corpus that describes it. */
function sourceFiles() {
  const out = execFileSync('rg', ['-l', '--glob', '*.js', '', 'src'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

/**
 * Replace comment and string *bodies* with spaces, preserving offsets and
 * length so brace matching stays aligned. A regex literal is not modelled: the
 * patterns in this tree do not carry bare braces, and guessing at the
 * division-versus-regex ambiguity would cost more than it buys.
 */
function blankCommentsAndStrings(source) {
  const out = [...source]
  let i = 0
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ' }
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      let k = i + 1
      while (k < source.length) {
        if (source[k] === '\\') { k += 2; continue }
        if (source[k] === quote) break
        k += 1
      }
      blank(i + 1, Math.min(k, source.length))
      i = k + 1
    } else {
      i += 1
    }
  }
  return out.join('')
}

/**
 * Keys repeated within one object literal.
 *
 * A key is an identifier followed by `:` whose previous significant character
 * is the literal's `{` or a `,` at the same depth. The previous-character test
 * is what excludes ternaries (`cond ? a : b`) and `case x:` labels, both of
 * which produce the same `identifier :` shape inside a block.
 */
function duplicateKeys(source) {
  const clean = blankCommentsAndStrings(source)
  const found = []
  const stack = []
  let i = 0
  while (i < clean.length) {
    const ch = clean[i]
    if (ch === '{') {
      stack.push({ keys: new Map(), depth: stack.length })
      i += 1
      continue
    }
    if (ch === '}') {
      const frame = stack.pop()
      if (frame) {
        for (const [key, first] of frame.keys) {
          if (first.duplicate) found.push({ key, line: first.duplicate })
        }
      }
      i += 1
      continue
    }
    const frame = stack[stack.length - 1]
    if (frame) {
      const match = /^[A-Za-z_$][\w$]*\s*:/.exec(clean.slice(i))
      if (match) {
        let back = i - 1
        while (back >= 0 && /\s/.test(clean[back])) back -= 1
        const before = clean[back]
        if (before === '{' || before === ',') {
          const key = match[0].slice(0, match[0].indexOf(':')).trim()
          if (frame.keys.has(key)) {
            frame.keys.get(key).duplicate = clean.slice(0, i).split('\n').length
          } else {
            frame.keys.set(key, { line: clean.slice(0, i).split('\n').length })
          }
          i += match[0].length
          continue
        }
      }
    }
    i += 1
  }
  return found
}

describe('VER-11 no object literal declares the same key twice', () => {
  it('finds no duplicate key anywhere in src/', () => {
    const files = sourceFiles()
    const offenders = []
    for (const file of files) {
      for (const { key, line } of duplicateKeys(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
        offenders.push(`${file}:${line} ${key}`)
      }
    }
    assert.deepEqual(offenders, [], `duplicate key(s) in one object literal: ${offenders.join(', ')}`)
  })

  it('canaries on a literal that repeats a key, and passes one that does not', () => {
    assert.deepEqual(duplicateKeys('const a = { x: 1, x: 2 }\n'), [{ key: 'x', line: 1 }])
    // A nested literal reusing its parent's key is legal and appears in this tree.
    assert.deepEqual(duplicateKeys('const a = { x: { x: 1 } }\n'), [])
    // Ternaries and switch labels share the `identifier :` shape and are not keys.
    assert.deepEqual(duplicateKeys('const a = c ? x : y\n'), [])
    assert.deepEqual(duplicateKeys('switch (a) { case x: break; case y: break }\n'), [])
  })
})
