# Aperture Native Integration - Testing Guide

## Current Status
✅ Aperture has been successfully integrated into VIPER as a native module
✅ All code is in place and files are being served correctly
✅ Test .mbox file has been created at: `test-sample.mbox`

## Testing Steps

### Step 1: Enable Aperture Feature
You have two options:

**Option A - Using Settings UI:**
1. In VIPER, click the settings icon (gear icon) in the sidebar
2. Scroll down to "Investigative Tools" section
3. Toggle the Aperture switch to ON (it should turn orange)
4. You should see a success notification

**Option B - Using Test Page:**
1. Navigate to: `http://localhost:8000/test-enable-aperture.html`
2. Click "Enable Aperture" button
3. You should see "Aperture enabled!" message

### Step 2: Verify Aperture is Enabled
1. Go back to the Settings page
2. The Aperture toggle should be in the ON position (orange/enabled state)
3. Or use the test page and click "Check Status" - it should show "true"

### Step 3: Add Aperture to a Case
You have two options:

**Option A - Using VIPER UI:**
1. Go to the main dashboard (click VIPER logo)
2. Either create a new case or open an existing one
3. Once in a case, you should see tabs at the top
4. The Aperture tab should now be visible (if enabled in settings)

**Option B - Using Test Page:**
1. Make sure you have a case open in VIPER
2. Go to: `http://localhost:8000/test-enable-aperture.html`
3. Click "Add Aperture to Current Case"
4. You should see confirmation message
5. Refresh the case page to see the Aperture tab

### Step 4: Access Aperture Tab
1. Open a case (or refresh if already open)
2. Look for the "Aperture" tab at the top of the case detail page
3. Click on it
4. You should see the Aperture interface with:
   - APERTURE header
   - "Import .mbox" button
   - Statistics cards (showing 0 emails initially)
   - Email list sidebar (empty initially)
   - Email detail view

### Step 5: Test Importing .mbox File
1. Click the "Import .mbox" button (📁 folder icon)
2. A dialog should appear asking for:
   - Source Name (enter something like "Test Account 1")
   - .mbox file selection
3. Click "Choose File" and select: `test-sample.mbox` from the VIPER directory
4. Click "Import"
5. Wait for processing...

### Expected Results After Import:
- Statistics should update to show:
  - Total Emails: 3
  - Sources: 1
  - Flagged: 0
  - Attachments: 0
- Email list should show 3 emails:
  - "Team Meeting Notes" from Bob Johnson
  - "Re: Test Email 1" from Jane Smith
  - "Test Email 1" from John Doe
- Click on any email to see details in the right panel

### Step 6: Test Email Features
1. **Click on an email** - Details should appear on the right
2. **Flag an email** - Click the flag icon (🚩), it should turn colored
3. **Search** - Type in the search box, emails should filter
4. **Filter by source** - Use the source dropdown to filter
5. **Filter by type** - Use the filter dropdown (All/Flagged/Attachments)
6. **View headers** - Click "Show Headers" to expand email headers

### Step 7: Test Multiple Sources
1. Click "Import .mbox" again
2. Enter a different source name (e.g., "Test Account 2")
3. Select the same test .mbox file (in real use, you'd select a different file)
4. Import it
5. Statistics should now show:
   - Total Emails: 6
   - Sources: 2
6. Use the source filter dropdown to switch between sources

### Step 8: Verify Case Isolation
1. Navigate back to dashboard
2. Open a different case (or create a new one)
3. Enable Aperture tab for this case
4. The Aperture tab in this case should be empty (0 emails)
5. This confirms data is properly isolated per case

## Troubleshooting

### If Aperture tab doesn't appear:
1. Check settings - make sure Aperture is enabled
2. Check browser console (F12) for any JavaScript errors
3. Verify the case has 'aperture' in its modules array
4. Try refreshing the page

### If import fails:
1. Check browser console for errors
2. Verify the .mbox file exists and is readable
3. Check the VIPER terminal for backend errors
4. Ensure mailparser npm package is installed

### If emails don't display:
1. Check browser console for errors
2. Verify the aperture-ui.js loaded correctly
3. Check if data was saved (look in cases/[case-id]/aperture/ folder)

### Common Issues:
- **Module not loaded error**: Refresh the page, check script tags in HTML
- **IPC errors**: Make sure electron-main.js was updated and VIPER restarted
- **File access errors**: Check file permissions on cases directory
- **Parsing errors**: Verify .mbox file format is correct

## Files to Check
If something doesn't work, check these locations:

**Frontend:**
- `case-detail-with-analytics.html` - Check if scripts are loaded
- Browser DevTools Console - Check for JavaScript errors

**Backend:**
- VIPER terminal output - Check for Node.js/Electron errors
- `cases/[case-id]/aperture/` - Check if data is being saved

**Modules:**
- `modules/aperture/aperture-module.js`
- `modules/aperture/aperture-ui.js`
- `modules/aperture/aperture-parser.js`
- `modules/aperture/aperture-data.js`

## Test Data Location
- Test .mbox file: `C:\Users\JUSTI\VIPER\test-sample.mbox`
- Contains 3 sample emails for testing

## Success Criteria
✅ Aperture toggle works in settings
✅ Aperture tab appears in cases when enabled
✅ Can import .mbox files
✅ Emails display in list and detail view
✅ Can flag emails
✅ Search and filters work
✅ Multiple sources are supported
✅ Data is isolated per case
✅ UI matches VIPER aesthetics

## Next Steps After Testing
Once basic functionality is confirmed:
1. Test with real .mbox files (larger datasets)
2. Test edge cases (malformed emails, large attachments, etc.)
3. Add attachment viewer functionality
4. Add email export capabilities
5. Optimize performance for large datasets
6. Add additional analysis features
