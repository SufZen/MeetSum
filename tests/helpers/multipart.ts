/**
 * Builds a streamed multipart Request the way a network client would send it
 * (a plain ReadableStream body, chunked), rather than undici's FormData body
 * whose internal generator misbehaves when the consumer cancels early.
 */
export async function streamedMultipartRequest(
  url: string,
  form: FormData,
  options: { headers?: Record<string, string>; chunkSize?: number } = {}
): Promise<Request> {
  const serialized = new Response(form)
  const contentType = serialized.headers.get("content-type") ?? ""
  const bytes = new Uint8Array(await serialized.arrayBuffer())
  const chunkSize = options.chunkSize ?? 16 * 1024
  let offset = 0

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }

      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })

  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.length),
      ...options.headers,
    },
    duplex: "half",
  } as RequestInit)
}

export function wavBytes(size = 64): Buffer {
  const bytes = Buffer.alloc(size)
  bytes.write("RIFF", 0, "latin1")
  bytes.writeUInt32LE(size - 8, 4)
  bytes.write("WAVE", 8, "latin1")
  return bytes
}

export function wavFile(name = "meeting.wav", size = 64): File {
  return new File([new Uint8Array(wavBytes(size))], name, { type: "audio/wav" })
}
