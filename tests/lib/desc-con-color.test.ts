// El color del renglón tiene que llegar al remito, a la cuenta del cliente y al
// certificado. Los casos de acá están verificados contra public.desc_con_color()
// en la base (20260913t/u): las dos implementaciones tienen que dar lo mismo.
import { describe, it, expect } from 'vitest'
import { descConColor } from '../../src/lib/desc-con-color.js'

describe('descConColor', () => {
  it('agrega el color entre paréntesis', () => {
    expect(descConColor('Sellador PU Sikaflex 1A Plus x 300ml', 'negro'))
      .toBe('Sellador PU Sikaflex 1A Plus x 300ml (negro)')
  })

  it('sin color, deja la descripción intacta', () => {
    expect(descConColor('Cerámico piso 45x45', null)).toBe('Cerámico piso 45x45')
    expect(descConColor('Cerámico piso 45x45', undefined)).toBe('Cerámico piso 45x45')
    expect(descConColor('Cerámico piso 45x45', '')).toBe('Cerámico piso 45x45')
    expect(descConColor('Cerámico piso 45x45', '   ')).toBe('Cerámico piso 45x45')
  })

  it('no repite el color si ya está en el nombre de la ficha', () => {
    // Caso real: la ficha 799 lleva "Divine White" en el nombre.
    const f = 'Látex interior Loxon LD antimanchas satinado SW 6105 Divine White x 20lts'
    expect(descConColor(f, 'divine white')).toBe(f)
    expect(descConColor(f, 'Divine White')).toBe(f)
  })

  it('ignora acentos y puntuación al comparar: por eso usa norm_txt y no norm_material', () => {
    // Los colores de cable unipolar se escriben de las dos formas.
    const cable = 'Cable unipolar 1.5mm² verde-amarillo'
    expect(descConColor(cable, 'verde amarillo')).toBe(cable)
    expect(descConColor(cable, 'verde-amarillo')).toBe(cable)
    expect(descConColor('Membrana líquida Sikafill roja x kg', 'ROJA'))
      .toBe('Membrana líquida Sikafill roja x kg')
  })

  it('recorta los espacios del color pero conserva cómo lo escribió el usuario', () => {
    expect(descConColor('Pastina x 5kg', '  Gris Perla  ')).toBe('Pastina x 5kg (Gris Perla)')
  })

  it('tolera una descripción vacía sin explotar', () => {
    expect(descConColor(null, 'negro')).toBe(' (negro)')
    expect(descConColor('', null)).toBe('')
  })
})
