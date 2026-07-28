import { JWT } from 'google-auth-library'

// Triggers a Cloud Run Job execution via the Admin API's jobs.run endpoint.
// Different auth flow from fetchCloudRun (lib/cloudRunAuth.ts): a Job has no
// URL to invoke, so this uses an OAuth2 *access* token (cloud-platform scope)
// rather than an OIDC *ID* token scoped to a service's audience.
//
// jobName must be the full resource name, e.g.
//   projects/fssspark/locations/us-central1/jobs/recovery-pdf-job
//
// Returns once the execution is queued — it does not wait for the job to finish.
export async function runCloudRunJob(
  jobName: string,
  envOverrides: Record<string, string>,
): Promise<void> {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (!credsJson) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set')

  const creds = JSON.parse(credsJson)

  const jwtClient = new JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })

  const { token } = await jwtClient.getAccessToken()
  if (!token) throw new Error('Failed to obtain access token for Cloud Run Jobs API')

  const res = await fetch(`https://run.googleapis.com/v2/${jobName}:run`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{
          env: Object.entries(envOverrides).map(([name, value]) => ({ name, value })),
        }],
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Cloud Run Job trigger failed (${res.status}): ${await res.text()}`)
  }
}
