import { useState } from "react";
import { signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "../lib/firebase";
import FSSLogo from "./FSSLogo";

const NS = "'Nunito Sans', sans-serif";

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      onLogin(cred.user);
    } catch (err) {
      setError("Invalid email or password. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError("");
    setGoogleLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const userEmail = cred.user.email || "";
      if (!userEmail.endsWith("@fsldigital.com")) {
        await cred.user.delete();
        setError("Only @fsldigital.com accounts are allowed.");
        return;
      }
      onLogin(cred.user);
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") {
        setError("Google sign-in failed. Please try again.");
      }
    } finally {
      setGoogleLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.logoRow}>
          <FSSLogo height={82} />
          <div style={styles.logoTextWrap}>
            <span style={styles.logoTitle}>Fintech Solutions Services</span>
            <span style={styles.logoSub}>FSS</span>
          </div>
        </div>

        <div style={styles.divider} />

        <h1 style={styles.heading}>Welcome back</h1>
        <p style={styles.subheading}>Sign in to access the reconciliation app</p>

        {/* Google Sign-in */}
        <button
          type="button"
          onClick={handleGoogle}
          disabled={googleLoading || loading}
          style={{ ...styles.googleBtn, opacity: googleLoading ? 0.7 : 1 }}
        >
          {googleLoading ? (
            <div style={styles.googleSpinner} />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
          )}
          {googleLoading ? "Signing in…" : "Continue with Google"}
        </button>

        {/* Divider */}
        <div style={styles.orRow}>
          <div style={styles.orLine} />
          <span style={styles.orText}>or sign in with email</span>
          <div style={styles.orLine} />
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              placeholder="you@fsldigital.com"
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              placeholder="enter password"
              required
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button
            type="submit"
            style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}
            disabled={loading || googleLoading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #f0faf0 0%, #e8f5e9 100%)",
    padding: "24px",
  },
  card: {
    background: "#fff",
    borderRadius: "16px",
    padding: "48px 40px",
    width: "100%",
    maxWidth: "420px",
    boxShadow: "0 8px 40px rgba(46,125,50,0.10)",
    border: "1px solid #e0efe0",
  },
  logoRow: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    marginBottom: "10px",
  },
  logoTextWrap: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  logoTitle: {
    fontFamily: NS,
    fontWeight: "700",
    fontSize: "16px",
    color: "#1B5E20",
    letterSpacing: "0.2px",
    lineHeight: 1.2,
  },
  logoSub: {
    fontFamily: NS,
    fontWeight: "600",
    fontSize: "13px",
    color: "#47B651",
    letterSpacing: "2px",
  },
  divider: {
    height: "1px",
    background: "#e8f0e8",
    marginBottom: "20px",
  },
  heading: {
    fontFamily: NS,
    fontSize: "22px",
    fontWeight: "700",
    color: "#1B5E20",
    marginBottom: "6px",
    letterSpacing: "-0.3px",
  },
  subheading: {
    fontFamily: NS,
    fontSize: "13px",
    color: "#5A8A5A",
    marginBottom: "20px",
  },
  googleBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "100%",
    padding: "11px",
    border: "1.5px solid #D4DCD4",
    borderRadius: "8px",
    background: "#fff",
    cursor: "pointer",
    fontFamily: NS,
    fontSize: "13px",
    fontWeight: "600",
    color: "#1C211C",
    marginBottom: "4px",
  },
  googleSpinner: {
    width: "14px",
    height: "14px",
    border: "2px solid #D4DCD4",
    borderTopColor: "#2E7D32",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  orRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    margin: "20px 0",
  },
  orLine: { flex: 1, height: "1px", background: "#e8f0e8" },
  orText: {
    fontFamily: NS,
    fontSize: "11px",
    color: "#A8B4A8",
    whiteSpace: "nowrap",
  },
  form: { display: "flex", flexDirection: "column", gap: "18px" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: {
    fontFamily: NS,
    fontSize: "11px",
    fontWeight: "700",
    color: "#2A4A2A",
    textTransform: "uppercase",
    letterSpacing: "0.7px",
  },
  input: {
    fontFamily: NS,
    fontSize: "13px",
    padding: "10px 14px",
    border: "1.5px solid #C8DCC8",
    borderRadius: "8px",
    outline: "none",
    color: "#111411",
    background: "#F7FBF7",
  },
  error: {
    background: "#FFEBEE",
    color: "#C62828",
    fontSize: "12px",
    fontFamily: NS,
    padding: "10px 14px",
    borderRadius: "6px",
    border: "1px solid #FFCDD2",
  },
  btn: {
    background: "#2E7D32",
    color: "#fff",
    fontFamily: NS,
    fontWeight: "700",
    fontSize: "13px",
    padding: "12px",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    marginTop: "4px",
    letterSpacing: "0.3px",
  },
};
