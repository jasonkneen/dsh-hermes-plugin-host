/**
 * Boot-safety regression harness.
 *
 * Runs the shipped client half the way the Harness does (module loader → factory
 * → apply) against a context that OBEYS the Cordis rule this bug violated: a
 * service may only be read through ctx.get() unless it is listed in `inject`.
 * `ctx.<service>` for a non-injected service throws "cannot get property ... without
 * inject" — which aborted activation and failed the desktop web boot into safe mode.
 *
 * Usage: node test/strict-context.mjs   (needs react from ../tinyglade-plus-two)
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
const req = createRequire('/Users/jkneen/Documents/GitHub/tinyglade-plus-two/package.json')
const React = req('react')

let def = null
global.window = { __ModuleLoader__: { load: (d) => { def = d } }, addEventListener(){}, removeEventListener(){}, location: { hash: '' } }
const headStyles = []
global.document = {
  hidden: false,
  documentElement: { classList: { _s: new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)} } },
  createElement: (tag) => ({ tag, attrs: {}, setAttribute(k,v){this.attrs[k]=v}, appendChild(){}, removeChild(){}, focus(){}, contains(){return false}, style:{} }),
  head: { appendChild(el){ headStyles.push(el) }, removeChild(el){ const i=headStyles.indexOf(el); if(i>=0) headStyles.splice(i,1) } },
  addEventListener(){}, removeEventListener(){},
  body: null,
  getElementById(){ return null },
}
global.getComputedStyle = () => ({ backgroundColor: 'rgb(16, 18, 22)' })

const src = fs.readFileSync('/Users/jkneen/Documents/GitHub/dsh-hermes-plugin-host/client.js', 'utf8')
try {
  // Evaluate the classic script: it only calls window.__ModuleLoader__.load
  new Function('window','document','require','console', src)(global.window, global.document, (n) => { if (n === 'react') return React; throw new Error('unknown module '+n) }, console)
  console.log('script evaluated, loader called:', !!def, '| id:', def && def.id)
} catch (e) {
  console.log('SCRIPT EVAL THREW:', e && e.stack ? e.stack.split('\n').slice(0,6).join('\n') : e)
  process.exit(1)
}

let plugin
try {
  plugin = def.factory((n) => { if (n === 'react') return React; throw new Error('unknown module '+n) })
  console.log('factory ok. inject:', JSON.stringify(plugin.inject))
} catch (e) {
  console.log('FACTORY THREW:', e && e.stack ? e.stack.split('\n').slice(0,8).join('\n') : e)
  process.exit(1)
}

// Minimal but strict fake ctx: only the services we claim to inject.
const regs = []
const ctx = {
  slots: {
    inject: (key, cb) => { try { const d = cb(); return typeof d === 'function' ? d : () => {} } catch (e) { console.log('INJECT THREW for', key, ':', e && e.message); throw e } },
    register: (opts, comp) => { regs.push({ opts, comp }); return () => {} },
  },
  layout: { selectPanel(){} },
  get: (k) => (k === 'layout' ? { selectPanel(){} } : undefined),
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { console.log('EFFECT THREW:', e && e.message); throw e } },
}
/* Cordis throws when a service is read as a property without being injected;
   mimic that so this class of bug fails here instead of in the app. */
const ALLOWED = new Set(Object.keys(ctx).concat(['then']))
const strictCtx = new Proxy(ctx, {
  get(target, prop) {
    if (typeof prop === 'string' && !ALLOWED.has(prop)) {
      throw new Error('cannot get property "' + prop + '" without inject')
    }
    return target[prop]
  },
})
try {
  plugin.apply(strictCtx)
  console.log('apply ok. registrations:', regs.map(r => r.opts.name + ':' + (r.opts.key || r.opts.id)).join(', '))
} catch (e) {
  console.log('APPLY THREW:', e && e.stack ? e.stack.split('\n').slice(0,10).join('\n') : e)
  process.exit(1)
}
