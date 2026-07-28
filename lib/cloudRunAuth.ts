import { JWT } from 'google-auth-library'

export async function fetchCloudRun(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (!credsJson) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set')

  const creds    = JSON.parse(credsJson)
  const audience = new URL(url).origin

  const jwtClient = new JWT({
    email: creds.client_email,
    key:   creds.private_key,
    additionalClaims: { target_audience: audience },
  })

  const idToken = await jwtClient.fetchIdToken(audience)

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${idToken}`,
    },
  })
}
