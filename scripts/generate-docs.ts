import * as fs from 'node:fs'
import tsBlankSpace from 'ts-blank-space'
import jsdoc from 'jsdoc-api'
import { EntrypointDoc, Param, Returns, StaticProperty } from './types'

const source = tsBlankSpace(fs.readFileSync(process.argv[2], 'utf8'))

type JSDocPoint = {
  comment: string
  meta: {
    range: [number, number]
    filename: string
    lineno: number
    columno: number
    path: string
    code: {
      id: string
      name: string
      type: 'FunctionExpression' | 'ClassDeclaration' | 'MethodDefinition' | 'ClassProperty' | 'Literal'
      paramnames: string[]
    }
  }
  undocumented: boolean
  classdesc?: string
  description: string
  name: string
  longname: string
  kind: 'function' | 'member' | 'class'
  memberof?: string
  scope: 'global' | 'static' | 'instance'
  async?: boolean
  params?: Array<{ type: { names: string[] }; description: string; name: string; optional?: boolean }>
  returns?: Array<{ type: { names: string[] }; description: string }>
  examples?: string[]
  ignore?: boolean
}
const data = ((await jsdoc.explain({ source: source, cache: true })) as Array<JSDocPoint>)
  // Pretend ignored points don't exist
  .filter((point) => !point.ignore)

/* SEARCH FOR EXPORTED CLASSES */

const exported_classes: Record<string, EntrypointDoc> = {}
let default_export: { class_name: string; range: [number, number] } | undefined
for (const point of data) {
  // console.dir(point, { depth: null })
  // if (point.meta) console.log(source.substring(...point.meta.range))
  if (point.kind === 'class' && point.meta?.code?.type === 'ClassDeclaration') {
    let exported_as = null
    let name = point.meta.code.name
    if (name.startsWith('exports.')) {
      name = name.slice('exports.'.length)
      exported_as = name
    } else if (name === 'module.exports') {
      const raw = source.substring(...point.meta.range)
      const match = raw.match(/class (\w+) (extends|{)/)
      name = match ? match[1] : 'default'
      exported_as = 'default'
      default_export = { class_name: name, range: point.meta.range }
    }

    // console.dir(point, { depth: null })
    exported_classes[name] = Object.assign(exported_classes[name] || {}, {
      exported_as,
      description: point.classdesc! || null,
      methods: [],
      statics: {},
    })
    // console.log(exported_classes)
  }
}

/* SEARCH FOR CLASS METHODS OR STATICS */

for (const point of data) {
  // If it's a named export, we get `.memberof`. If it's a default export, we have to get creative
  const memberof =
    point.memberof === 'module.exports' || (!point.memberof && default_export && rangeWithin(point.meta?.range, default_export.range))
      ? default_export?.class_name
      : point.memberof

  /* CLASS METHODS */
  if (point.kind === 'function' && point.meta?.code?.type === 'MethodDefinition' && memberof) {
    const ex = exported_classes[memberof]
    if (!ex) {
      throw new Error(`Missing memberof ${memberof}. Got ${JSON.stringify(point)}, had ${JSON.stringify(Object.keys(exported_classes))}`)
    }

    let returns: Returns = null
    if (point.returns) {
      const [ret, ...rest] = point.returns
      if (!ret || rest.length > 0 || ret.type.names.length !== 1) {
        console.log(`WARN: unexpected returns value for ${JSON.stringify(point)}`)
      }
      returns = { description: ret.description, type: ret.type.names[0] }
    }

    const params: Param[] = (point.params || [])
      .map(({ description, type, name, optional }) => {
        if (type.names.length !== 1) {
          console.log(`WARN: unexpected params value for ${JSON.stringify(point)}`)
          return null
        }

        return { description, name, type: type.names[0], optional }
      })
      .filter((p) => p !== null)

    ex.methods.push({
      name: point.name,
      description: point.description,
      params,
      returns,
      ...(point.examples ? { examples: point.examples } : {}),
    })
  }

  /* STATICS */
  if (
    point.kind === 'member' &&
    point.meta?.code?.type === 'ClassProperty' &&
    memberof &&
    point.meta?.range &&
    source.substring(...point.meta.range).match(/^\s*static\s/)
  ) {
    // console.dir(point, { depth: null })

    const ex = exported_classes[memberof]
    if (!ex) {
      throw new Error(`Missing memberof ${memberof}. Got ${JSON.stringify(point)}, had ${JSON.stringify(Object.keys(exported_classes))}`)
    }

    const members: StaticProperty[] = []

    // Sadly jsdoc-api doesn't give us any reference between the members of this static property and the
    // static property itself. So we need to search the list of points for any that exist within the parent
    // property's range. I don't love having to do a nested loop (algorithmic complexity O(honey)) but this
    // is a POC and we're likely to replace jsdoc-api anyway get all the way off my back please.
    for (const subpoint of data) {
      if (subpoint.meta?.code?.id !== point.meta?.code?.id && rangeWithin(subpoint.meta?.range, point.meta.range)) {
        // console.dir(subpoint, { depth: null })
        const type = subpoint.meta?.code.type === 'Literal' ? 'string' : subpoint.returns?.[0]?.type?.names?.[0]
        members.push({
          name: subpoint.name,
          description: subpoint.description,
          type,
        })
      }
    }
    ex.statics[point.name] = members
  }
}

/* SEARCH FOR EXPORT RENAMES */

for (const point of data) {
  if (point.kind === 'member' && point.scope === 'global' && point.meta?.code?.name?.startsWith('exports.')) {
    let name = point.name
    const renamed = source.substring(...point.meta.range).match(/(\w+) as \w+/)
    if (renamed) {
      name = renamed[1]
    }
    if (exported_classes[name]) {
      exported_classes[name].exported_as = point.name
    } else {
      console.log(`WARN: couldn't find which class to export for ${JSON.stringify(point)}`)
    }
  }
}

console.log(JSON.stringify(exported_classes, null, 2))

function rangeWithin(inner: [number, number] | undefined, outer: [number, number]) {
  if (!inner) return false

  const [a, b] = inner
  const [x, y] = outer
  return a >= x && b <= y
}
