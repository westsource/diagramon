using Avalonia.Controls;
using Mermaider.ViewModels;

namespace Mermaider.Views;

public partial class ImageScaleSettingsDialog : Window
{
    public ImageScaleSettingsDialog()
    {
        InitializeComponent();
    }

    public ImageScaleSettingsDialog(ImageScaleSettingsViewModel viewModel) : this()
    {
        DataContext = viewModel;
    }
}
