# OutTime

A browser extension that logs into HRIS for you and tells you your in-time and expected out-time, without you having to open the site yourself.

## Installation

1. Download and unzip the **OutTime** folder if it's zipped.
2. Open your browser (Chrome or Edge) and go to the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode** (toggle, usually top-right).
4. Click **Load unpacked**.
5. Select the extracted **OutTime** folder.
6. Pin the extension so it's easy to reach: click the puzzle-piece icon in your toolbar, then click the pin next to OutTime.

## Setup

1. Click the OutTime icon in your toolbar.
2. Enter your HRIS **User ID** and **Password**, and save them.
3. Click **Get Details**.

The extension will log in and fetch your today's in-time and estimated out-time in the background — no need to open HRIS yourself.

## DTS filling

Open the popup's **DTS filling** section:

- **Default config**: mode (Work from home or Office), date (blank = today), maximum hours per row (default 4), and the Project / Module / Activity / Status text used to pick the dropdown options. All of it is saved when you click Save config or Fill DTS.
- **Time rows**: in WFH mode each row is a plain From and To time. In Office mode each row also gets **From** and **To** dropdowns:
  - From: *Custom time*, *System in-time* (what the form shows for the date) or *After previous row* (+ a gap in minutes).
  - To: *Custom time*, *System out-time* or *Hours after From*.
  - Two rows are pre-filled; add or remove rows as needed. A row can't be longer than the maximum, From must be before To, and rows can't overlap.
- **Fill DTS** logs in, opens IT Services -> DTS, adds every row and leaves the DTS tab open for you to review. By default it does not press Save/Submit; pick an option under "After adding the rows" to change that.

## Notes

- Your credentials are stored locally in your browser, not sent anywhere else.
- The first click after installing/reloading the extension may occasionally need a second try while the browser wakes it up — after that it runs smoothly.