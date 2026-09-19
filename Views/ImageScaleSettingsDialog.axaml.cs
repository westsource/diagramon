using Avalonia.Controls;
using Diagramon.ViewModels;

namespace Diagramon.Views;

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
