import { describe, it, expect } from 'vitest'
import { opcionesSignedUrl, esVisibleInline, quiereDescargar } from '../../src/lib/signed-url.js'

describe('opcionesSignedUrl', () => {
  it('PDF e imágenes se abren inline (sin download)', () => {
    expect(opcionesSignedUrl({ nombre: 'factura.pdf', path: 'facturas/1/a.pdf', mime: 'application/pdf' })).toBeUndefined()
    for (const [ext, mime] of [['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['heic', 'image/heic']]) {
      expect(opcionesSignedUrl({ nombre: `foto.${ext}`, path: `x/y.${ext}`, mime })).toBeUndefined()
    }
    expect(opcionesSignedUrl({ nombre: 'notas.txt', mime: 'text/plain; charset=utf-8' })).toBeUndefined()
  })

  it('mayúsculas y nombre sin extensión: decide el mime / el path', () => {
    expect(opcionesSignedUrl({ nombre: 'FACTURA.PDF', path: 'a/b.PDF', mime: 'APPLICATION/PDF' })).toBeUndefined()
    expect(opcionesSignedUrl({ nombre: 'Factura 0001.00001234', path: 'a/b.pdf', mime: 'application/pdf' })).toBeUndefined()
    expect(opcionesSignedUrl({ nombre: 'comprobante', path: 'a/b.jpg' })).toBeUndefined()
  })

  it('lo que no es visible se baja con su nombre original', () => {
    expect(opcionesSignedUrl({ nombre: 'planilla.xlsx', path: 'a/b.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      .toEqual({ download: 'planilla.xlsx' })
    expect(opcionesSignedUrl({ nombre: 'contrato.docx', path: 'a/b.docx' })).toEqual({ download: 'contrato.docx' })
    expect(opcionesSignedUrl({ nombre: 'todo.zip' })).toEqual({ download: 'todo.zip' })
    expect(opcionesSignedUrl({ nombre: 'raro', path: 'a/b.bin', mime: 'application/octet-stream' })).toEqual({ download: 'raro' })
  })

  it('HTML, SVG y XML nunca inline, aunque otra señal diga que sí', () => {
    expect(opcionesSignedUrl({ nombre: 'x.html', path: 'a/b.pdf', mime: 'application/pdf' })).toEqual({ download: 'x.html' })
    expect(opcionesSignedUrl({ nombre: 'plano.svg', mime: 'image/svg+xml' })).toEqual({ download: 'plano.svg' })
    expect(opcionesSignedUrl({ nombre: 'f.pdf', path: 'a/b.pdf', mime: 'text/html' })).toEqual({ download: 'f.pdf' })
    expect(opcionesSignedUrl({ nombre: 'f.pdf', path: 'a/b.svg', mime: 'application/pdf' })).toEqual({ download: 'f.pdf' })
    expect(opcionesSignedUrl({ nombre: 'd.xml', mime: 'application/xml' })).toEqual({ download: 'd.xml' })
    expect(esVisibleInline({ nombre: 'foto.jpg.htm' })).toBe(false)
  })

  it('sin ninguna señal, se baja', () => {
    expect(opcionesSignedUrl({})).toEqual({ download: true })
    expect(opcionesSignedUrl({ nombre: 'sin extension' })).toEqual({ download: 'sin extension' })
  })

  it('descargar=true fuerza la descarga de cualquier tipo', () => {
    expect(opcionesSignedUrl({ nombre: 'factura.pdf', path: 'a/b.pdf', mime: 'application/pdf', descargar: true })).toEqual({ download: 'factura.pdf' })
    expect(opcionesSignedUrl({ nombre: null, path: 'a/b.png', descargar: true })).toEqual({ download: true })
    expect(opcionesSignedUrl({ nombre: '  ', path: 'a/b.png', descargar: true })).toEqual({ download: true })
  })
})

describe('quiereDescargar', () => {
  it('lee el query param', () => {
    for (const v of ['1', 'true', 'TRUE', 'si', 'sí', ' 1 ']) expect(quiereDescargar(v)).toBe(true)
    for (const v of [undefined, null, '', '0', 'false', 'no']) expect(quiereDescargar(v)).toBe(false)
  })
})
