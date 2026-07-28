import { initializeApp, getApps, cert, App } from 'firebase-admin/app'
import { getAuth }                            from 'firebase-admin/auth'

let adminApp: App

function getAdminApp(): App {
  if (adminApp) return adminApp
  if (getApps().length) {
    adminApp = getApps()[0]
    return adminApp
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : {
        project_id: process.env.FIREBASE_ADMIN_PROJECT_ID,
        client_email: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      'Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_ADMIN_PROJECT_ID/FIREBASE_ADMIN_CLIENT_EMAIL/FIREBASE_ADMIN_PRIVATE_KEY.'
    )
  }

  adminApp = initializeApp({
    credential: cert(serviceAccount),
  })

  return adminApp
}

export function getAdminAuth() {
  return getAuth(getAdminApp())
}

/**
 * Verify the Firebase ID token from the Authorization header.
 * Returns the decoded token (uid, email, etc.) or throws.
 */
export async function verifyToken(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header')
  }
  const idToken = authHeader.split('Bearer ')[1]
  return getAdminAuth().verifyIdToken(idToken)
}
