# Deploy AI OS to accredready.in

Copy these into your **nabh-compliance** repo, then push to `master`:

```
accredready-in/ai-os/index.html     →  public/ai-os/index.html
accredready-in/deploy.yml           →  .github/workflows/deploy.yml
```

After push, GitHub Actions will auto-deploy to **https://accredready.in/ai-os/**

Or manually: `npm run build && npm run deploy`

## Login

Use the **exact same email and password** as https://accredready.in  
"Invalid login credentials" = wrong password (reset on accredready.in).
