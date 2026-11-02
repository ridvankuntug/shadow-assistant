package app.shadowassistant.android

/** Splits long replies for TextToSpeech, which rejects input over its maximum length. */
object TtsText {
    private val sentenceEnd = Regex("(?<=[.!?…])\\s+")

    fun split(text: String, maxLength: Int): List<String> {
        require(maxLength > 0)
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return emptyList()
        if (trimmed.length <= maxLength) return listOf(trimmed)
        val out = mutableListOf<String>()
        val current = StringBuilder()
        fun flush() {
            if (current.isNotBlank()) out.add(current.toString().trim())
            current.setLength(0)
        }
        for (sentence in trimmed.split(sentenceEnd)) {
            var piece = sentence.trim()
            while (piece.length > maxLength) {
                flush()
                // Hard split at the last space before the limit, else at the limit.
                val space = piece.lastIndexOf(' ', maxLength)
                val cut = if (space > 0) space else maxLength
                out.add(piece.substring(0, cut).trim())
                piece = piece.substring(cut).trim()
            }
            if (piece.isEmpty()) continue
            if (current.isNotEmpty() && current.length + 1 + piece.length > maxLength) flush()
            if (current.isNotEmpty()) current.append(' ')
            current.append(piece)
        }
        flush()
        return out.filter { it.isNotEmpty() }
    }
}
