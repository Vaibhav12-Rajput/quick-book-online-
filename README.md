# QuickBooks OAuth Integration Setup

This guide will walk you through setting up QuickBooks OAuth credentials and integrating them into your application.

## Step 1: Create an Intuit Developer Account
1. Visit the [Intuit Developer Portal](https://developer.intuit.com/).
2. Create a developer account or log in if you already have one.

## Step 2: Create an App in Intuit Developer Portal
1. Navigate to **My Apps** and click **Create an App**.
2. Choose **QuickBooks Online**.
3. Provide a name for your app and create the app.

## Step 3: Obtain Client ID and Client Secret
1. Go to the **Keys & OAuth** section of your app's dashboard.
2. Note down the **Client ID** and **Client Secret**.

## Step 4: Set Redirect URI
1. Under **Redirect URIs** in the **Keys & OAuth** section, set your **Redirect URI**.
2. Example Redirect URI: `http://localhost:5000/api/auth/callback`.

## Step 5: Add Credentials to .env File
Update the file at the root of your project

```plaintext
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:5000/api/auth/callback?key=your-key
REDIRECT_UI_URL=http://localhost:3000/true
ENVIRONMENT=sandbox

## Step 6: Hit the connect 

curl for the connect api 

curl --location 'http://localhost:8080/api/auth?appType=QUICKBOOKS_ONLINE' \
--header 'sec-ch-ua-platform: "Windows"' \
--header 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTcy8wWTZiUkIwVUQyMksveXkzbFRiRTU3SEJtK2Z3SXVZRm85Q1ZXYWg4PSIsImlhdCI6MTc0NTU2MjQzMiwiZXhwIjoxNzQ1NjQ4ODMyfQ.p6OqsUUl56CQ03rEzmV-Iju4qT7zzOmO_umYxMlOYms' \
--header 'Referer: http://localhost:8080/connect' \
--header 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36' \
--header 'Accept: application/json, text/plain, */*' \
--header 'sec-ch-ua: "Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"' \
--header 'sec-ch-ua-mobile: ?0' \
--header 'Cookie: JSESSIONID=3E03BA5F9856704A572CB44A7EE83CD3'

