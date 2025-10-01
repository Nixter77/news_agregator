from playwright.sync_api import sync_playwright, expect

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    try:
        # Navigate to the app
        page.goto("http://localhost:8501")

        # Wait for the sidebar to be ready
        page.wait_for_selector("aside[data-testid='stSidebar']")

        # Select the first two sources
        source_multiselect = page.locator(".stMultiSelect")
        source_multiselect.click()
        page.locator("li", has_text="BBC News").click()
        page.locator("li", has_text="Al Jazeera").click()

        # Click outside the multiselect to close it
        page.get_by_text("⚙️ Параметры").click()


        # Click the "run" button
        run_button = page.get_by_role("button", name="🚀 Собрать новости")
        run_button.click()

        # Wait for pictograms to appear (wait for the first image that is not a source image)
        # This is a bit tricky, we will wait for the success message first
        expect(page.locator(".stAlert.st-emotion-cache-1uv20hb.e1f1d6gn3")).to_be_visible(timeout=60000)

        # Then wait for the first pictogram image
        expect(page.locator("img.st-emotion-cache-1vcd9dd.e115fcil1").first).to_be_visible(timeout=30000)


        # Take a screenshot
        page.screenshot(path="jules-scratch/verification/verification.png")

    except Exception as e:
        print(f"An error occurred: {e}")
        page.screenshot(path="jules-scratch/verification/error.png")

    finally:
        browser.close()

with sync_playwright() as playwright:
    run(playwright)