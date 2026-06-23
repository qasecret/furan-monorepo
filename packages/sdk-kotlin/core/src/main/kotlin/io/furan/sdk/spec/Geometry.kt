package io.furan.sdk.spec

/** A rectangle in image/page pixels. */
data class Rect(val x: Int, val y: Int, val width: Int, val height: Int)

/** A width × height size in pixels. */
data class Size(val width: Int, val height: Int)
