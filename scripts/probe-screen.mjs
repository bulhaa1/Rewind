/** Reports the window and display geometry (used for the framed/DPI checks). */
export default async function ({ evaluate }) {
  const info = await evaluate('({ screenW: screen.width, screenH: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: window.devicePixelRatio, outerW: window.outerWidth, outerH: window.outerHeight })')
  console.log(JSON.stringify(info, null, 2))
}
