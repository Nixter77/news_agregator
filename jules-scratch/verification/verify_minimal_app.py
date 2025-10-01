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

        # Click the "run" button
        run_button = page.get_by_role("button", name="🚀 Собрать новости")
        run_button.click()

        # Check for the success message
        expect(page.locator("text=Кнопка работает!")).to_be_visible()

        # Take a screenshot
        page.screenshot(path="jules-scratch/verification/minimal_app_verification.png")

    except Exception as e:
        print(f"An error occurred: {e}")
        page.screenshot(path="jules-scratch/verification/minimal_app_error.png")

    finally:
        browser.close()

with sync_playwright() as playwright:
    run(playwright)